import { checkSenderRole } from "./roles.js";
export const SELFCONTROL_ACCESS_ERROR = "Website blocking is restricted to OWNER and ADMIN users.";
export async function getSelfControlAccess(runtime, message) {
    const roleCheck = await checkSenderRole(runtime, message);
    if (!roleCheck?.isAdmin) {
        return {
            allowed: false,
            role: roleCheck?.role ?? null,
            reason: SELFCONTROL_ACCESS_ERROR,
        };
    }
    return {
        allowed: true,
        role: roleCheck.role,
    };
}
