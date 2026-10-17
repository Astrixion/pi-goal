import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalCommandController, GoalResumeResult } from "./commands.js";
import { safeGoalMenuText } from "./errors.js";
import type { GoalStopCause } from "./persistence.js";
import type { GoalStatus } from "./prompts.js";
import type { GoalRuntime, StatusContext } from "./runtime.js";
import type { GoalSettings } from "./settings.js";

/** In-process observation/control API. Independent of the optional managed-run RPC. */
export interface GoalSnapshot {
  version: 1;
  /** Fresh binding identity on every start/reload, not Pi's durable session ID. */
  sessionId: string;
  revision: number;
  available: boolean;
  limits: GoalSettings["continuationLimits"];
  goal: null | {
    goalId: string;
    status: GoalStatus;
    automaticModelTurns: number;
    toolFreeRepeatCount: number;
    iteration: number;
    tokensUsed: number;
    timeUsedSeconds: number;
    tokenBudget?: number;
    safetyResetPending: boolean;
    waiting: null | { reason: string; resumeAt?: number; exhausted: boolean };
    stopCause: GoalStopCause | null;
  };
}

export interface GoalResumeRequest {
  requestId: string;
  sessionId: string;
  goalId: string;
  expectedStatus: GoalStatus;
  expectedRevision: number;
}

type GoalOperationResult =
  | { ok: true; resumedGoalId?: string }
  | { ok: false; code: "INVALID_REQUEST" | "NO_ACTIVE_SESSION" | "STALE_STATE" | "RESUME_IN_PROGRESS" | Extract<GoalResumeResult, { ok: false }>["code"] };

export type GoalProtocolResult = {
  version: 1;
  requestId: string;
  operation: "query" | "resume";
  snapshot: GoalSnapshot;
} & GoalOperationResult;

export class GoalStateController {
  private sessionId = randomUUID();
  private revision = 0;
  private ctx?: StatusContext;
  private available = false;
  private resuming = false;
  private fingerprint = "";

  constructor(private readonly runtime: GoalRuntime, private readonly commands: GoalCommandController) {
    runtime.onStateChanged = () => this.changed();
  }

  register(pi: ExtensionAPI) {
    pi.events.on("pi-goal:query", (data) => {
      const requestId = readRequestId(data);
      if (!requestId) return;
      this.reply(requestId, "query", { ok: true });
    });
    pi.events.on("pi-goal:resume", (data) => this.resume(data));
  }

  beginSession() {
    this.sessionId = randomUUID();
    this.ctx = undefined;
    this.available = false;
    this.resuming = false;
    this.revision = 0;
    this.fingerprint = "";
    this.changed();
    return this.sessionId;
  }

  ready(ctx: StatusContext, sessionId: string) {
    if (this.sessionId !== sessionId) return;
    this.ctx = ctx;
    this.available = true;
    this.changed();
  }

  shutdown() {
    this.ctx = undefined;
    this.available = false;
    this.changed();
  }

  private snapshot(): GoalSnapshot {
    const goal = this.available ? this.runtime.activeGoal : undefined;
    return {
      version: 1,
      sessionId: this.sessionId,
      revision: this.revision,
      available: this.available,
      limits: { ...this.runtime.settings.continuationLimits },
      goal: goal ? {
        goalId: goal.id,
        status: goal.status,
        automaticModelTurns: goal.automaticModelTurns,
        toolFreeRepeatCount: goal.toolFreeRepeatCount,
        iteration: goal.iteration,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
        safetyResetPending: goal.safetyResetPending === true,
        waiting: goal.waiting ? {
          reason: goal.waiting.reason.startsWith("Provider retries exhausted")
            ? "Provider retries exhausted"
            : safeGoalMenuText(goal.waiting.reason).slice(0, 1000),
          ...(goal.waiting.resumeAt === undefined ? {} : { resumeAt: goal.waiting.resumeAt }),
          exhausted: this.runtime.isGoalWaitExhausted(),
        } : null,
        // Never export raw terminal/provider errors. Older stopped records have an unknown cause.
        stopCause: goal.status === "active" || goal.status === "complete" ? null
          : goal.stopCause ?? goal.safetyPauseCause ?? "unknown",
      } : null,
    };
  }

  private changed() {
    const snapshot = this.snapshot();
    const fingerprint = JSON.stringify({ ...snapshot, revision: 0 });
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    snapshot.revision = ++this.revision;
    // Observation must not synchronously re-enter a half-finished canonical transition.
    queueMicrotask(() => {
      if (snapshot.sessionId === this.sessionId) this.runtime.pi.events.emit("pi-goal:changed", snapshot);
    });
  }

  private reply(requestId: string, operation: "query" | "resume", result: GoalOperationResult) {
    this.changed();
    this.runtime.pi.events.emit("pi-goal:result", {
      version: 1, requestId, operation, ...result, snapshot: this.snapshot(),
    });
  }

  private async resume(data: unknown) {
    const requestId = readRequestId(data);
    if (!requestId) return;
    const request = data as Partial<GoalResumeRequest>;
    if (typeof request.sessionId !== "string" || typeof request.goalId !== "string" ||
      typeof request.expectedStatus !== "string" || !Number.isSafeInteger(request.expectedRevision)) {
      this.reply(requestId, "resume", { ok: false, code: "INVALID_REQUEST" });
      return;
    }
    this.changed();
    const ctx = this.ctx;
    if (!ctx || !this.available) {
      this.reply(requestId, "resume", { ok: false, code: "NO_ACTIVE_SESSION" });
      return;
    }
    const isCurrent = () => {
      this.changed();
      return this.available && this.ctx === ctx && this.sessionId === request.sessionId &&
        this.revision === request.expectedRevision && this.runtime.activeGoal?.id === request.goalId &&
        this.runtime.activeGoal?.status === request.expectedStatus;
    };
    if (!isCurrent()) {
      this.reply(requestId, "resume", { ok: false, code: "STALE_STATE" });
      return;
    }
    if (this.resuming) {
      this.reply(requestId, "resume", { ok: false, code: "RESUME_IN_PROGRESS" });
      return;
    }
    const sessionId = this.sessionId;
    this.resuming = true;
    try {
      const result = await this.commands.resumeGoal(ctx, isCurrent,
        () => this.available && this.sessionId === sessionId && this.ctx === ctx);
      if (this.sessionId !== sessionId || this.ctx !== ctx) return;
      this.reply(requestId, "resume", result);
    } catch (error) {
      if (this.sessionId !== sessionId || this.ctx !== ctx) return;
      this.reply(requestId, "resume", { ok: false, code: "ACTIVATION_FAILED" });
      throw error;
    } finally {
      if (this.sessionId === sessionId) this.resuming = false;
    }
  }
}

function readRequestId(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const id = Reflect.get(data, "requestId");
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) ? id : undefined;
}
