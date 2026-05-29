import { z } from "zod";
import { type AuditAction } from "./actions.js";
export type AuditActorType = "user" | "api_key" | "service" | "system" | "agent";
export type AuditResult = "success" | "failure" | "denied";
export interface AuditActor {
    type: AuditActorType;
    id: string;
}
export interface AuditResource {
    type: string;
    id: string;
}
export interface AuditEvent {
    event_id: string;
    ts: string;
    actor: AuditActor;
    action: AuditAction;
    result: AuditResult;
    resource: AuditResource | null;
    ip?: string;
    user_agent?: string;
    request_id?: string;
    org_id?: string;
    metadata?: Record<string, unknown>;
}
export declare const AuditActorSchema: z.ZodObject<{
    type: z.ZodEnum<{
        agent: "agent";
        user: "user";
        system: "system";
        service: "service";
        api_key: "api_key";
    }>;
    id: z.ZodString;
}, z.core.$strip>;
export declare const AuditResourceSchema: z.ZodObject<{
    type: z.ZodString;
    id: z.ZodString;
}, z.core.$strip>;
export declare const AuditEventSchema: z.ZodObject<{
    event_id: z.ZodString;
    ts: z.ZodString;
    actor: z.ZodObject<{
        type: z.ZodEnum<{
            agent: "agent";
            user: "user";
            system: "system";
            service: "service";
            api_key: "api_key";
        }>;
        id: z.ZodString;
    }, z.core.$strip>;
    action: z.ZodEnum<{
        "auth.login": "auth.login";
        "auth.logout": "auth.logout";
        "auth.login.failed": "auth.login.failed";
        "auth.mfa.enroll": "auth.mfa.enroll";
        "auth.mfa.challenge": "auth.mfa.challenge";
        "auth.mfa.verify": "auth.mfa.verify";
        "auth.password.change": "auth.password.change";
        "auth.password.reset": "auth.password.reset";
        "auth.session.revoke": "auth.session.revoke";
        "api_key.create": "api_key.create";
        "api_key.revoke": "api_key.revoke";
        "api_key.use": "api_key.use";
        "api_key.rotate": "api_key.rotate";
        "secret.access": "secret.access";
        "secret.create": "secret.create";
        "secret.update": "secret.update";
        "secret.delete": "secret.delete";
        "plugin.install": "plugin.install";
        "plugin.uninstall": "plugin.uninstall";
        "plugin.grant": "plugin.grant";
        "plugin.revoke": "plugin.revoke";
        "plugin.execute": "plugin.execute";
        "plugin.denied": "plugin.denied";
        "agent.spawn": "agent.spawn";
        "agent.terminate": "agent.terminate";
        "agent.config.update": "agent.config.update";
        "agent.session_record": "agent.session_record";
        "vision.allowed": "vision.allowed";
        "vision.denied": "vision.denied";
        "payment.charge": "payment.charge";
        "payment.refund": "payment.refund";
        "redemption.payout": "redemption.payout";
        "redemption.request": "redemption.request";
        "admin.action": "admin.action";
        "admin.user.impersonate": "admin.user.impersonate";
        "admin.policy.update": "admin.policy.update";
        "data.export": "data.export";
        "data.delete_request": "data.delete_request";
        "data.delete_complete": "data.delete_complete";
        "kms.key.create": "kms.key.create";
        "kms.key.rotate": "kms.key.rotate";
        "kms.key.access": "kms.key.access";
    }>;
    result: z.ZodEnum<{
        success: "success";
        failure: "failure";
        denied: "denied";
    }>;
    resource: z.ZodNullable<z.ZodObject<{
        type: z.ZodString;
        id: z.ZodString;
    }, z.core.$strip>>;
    ip: z.ZodOptional<z.ZodString>;
    user_agent: z.ZodOptional<z.ZodString>;
    request_id: z.ZodOptional<z.ZodString>;
    org_id: z.ZodOptional<z.ZodString>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
/** UUIDv7 — sortable, monotonic-ish, fits the contract. */
export declare function newEventId(): string;
export declare function nowIso(): string;
//# sourceMappingURL=types.d.ts.map