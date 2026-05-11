package ai.elizaos.app;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * Reflection-only probe for Android Virtualization Framework / Microdroid.
 *
 * AVF is usable for privileged AOSP/system builds when the device image exposes
 * the framework and grants MANAGE_VIRTUAL_MACHINE. Normal Play Store APKs must
 * treat this as unavailable; the android-cloud build strips the permission and
 * the local agent service.
 */
public final class AndroidVirtualizationBridge {

    private static final String FEATURE_VIRTUALIZATION_FRAMEWORK =
        "android.software.virtualization_framework";
    private static final String PERMISSION_MANAGE_VIRTUAL_MACHINE =
        "android.permission.MANAGE_VIRTUAL_MACHINE";
    private static final String VMM_CLASS =
        "android.system.virtualmachine.VirtualMachineManager";

    private AndroidVirtualizationBridge() {}

    public static final class Probe {
        public boolean available;
        public boolean microdroidAvailable;
        public int apiLevel;
        public boolean hasFeature;
        public boolean hasPermissionDeclaration;
        public boolean hasPermissionGrant;
        public boolean hasVirtualizationService;
        public final JSONArray capabilities = new JSONArray();
        public String reason;
    }

    public static Probe probe(Context context) {
        Probe probe = new Probe();
        probe.apiLevel = Build.VERSION.SDK_INT;
        PackageManager pm = context.getPackageManager();
        probe.hasFeature = pm.hasSystemFeature(FEATURE_VIRTUALIZATION_FRAMEWORK);
        probe.hasPermissionDeclaration = declaresPermission(
            context,
            PERMISSION_MANAGE_VIRTUAL_MACHINE
        );
        probe.hasPermissionGrant =
            context.checkSelfPermission(PERMISSION_MANAGE_VIRTUAL_MACHINE)
                == PackageManager.PERMISSION_GRANTED;

        if (probe.apiLevel < 34) {
            probe.reason = "Android AVF requires API 34+";
            return probe;
        }
        if (!probe.hasFeature) {
            probe.reason = "Device image does not expose Android Virtualization Framework";
            return probe;
        }
        if (!probe.hasPermissionDeclaration || !probe.hasPermissionGrant) {
            probe.reason = "MANAGE_VIRTUAL_MACHINE is not declared or granted";
            return probe;
        }

        try {
            Class<?> managerClass = Class.forName(VMM_CLASS);
            Object manager = context.getSystemService(managerClass);
            probe.hasVirtualizationService = manager != null;
            if (manager == null) {
                probe.reason = "VirtualMachineManager service unavailable";
                return probe;
            }
            readCapabilities(manager, probe);
            probe.available = true;
            probe.microdroidAvailable = true;
            return probe;
        } catch (Throwable throwable) {
            probe.reason = throwable.getClass().getSimpleName() + ": " + throwable.getMessage();
            return probe;
        }
    }

    public static String probeJson(Context context) {
        Probe probe = probe(context);
        JSONObject json = new JSONObject();
        try {
            json.put("available", probe.available);
            json.put("microdroidAvailable", probe.microdroidAvailable);
            json.put("apiLevel", probe.apiLevel);
            json.put("hasFeature", probe.hasFeature);
            json.put("hasPermissionDeclaration", probe.hasPermissionDeclaration);
            json.put("hasPermissionGrant", probe.hasPermissionGrant);
            json.put("hasVirtualizationService", probe.hasVirtualizationService);
            json.put("capabilities", probe.capabilities);
            if (probe.reason != null) json.put("reason", probe.reason);
        } catch (Throwable ignored) {
            // JSONObject only throws for invalid values; all values above are primitives.
        }
        return json.toString();
    }

    public static String request(Context context, String requestJson) {
        String id = "android-avf-request";
        try {
            JSONObject request = new JSONObject(requestJson == null ? "{}" : requestJson);
            id = request.optString("id", id);
        } catch (Throwable ignored) {
            // Preserve default id and return a structured error below if needed.
        }

        Probe probe = probe(context);
        if (!probe.available) {
            return error(
                id,
                "ANDROID_AVF_UNAVAILABLE",
                probe.reason != null ? probe.reason : "Android AVF/Microdroid is unavailable",
                false
            );
        }

        return error(
            id,
            "ANDROID_AVF_BOUNDARY_NOT_ATTACHED",
            "Android AVF/Microdroid is available, but no Microdroid payload boundary is packaged for this build",
            false
        );
    }

    private static void readCapabilities(Object manager, Probe probe) {
        try {
            Method method = manager.getClass().getMethod("getCapabilities");
            Object capabilities = method.invoke(manager);
            if (capabilities == null) return;
            if (capabilities instanceof Number) {
                int flags = ((Number) capabilities).intValue();
                addFlagCapability(manager.getClass(), probe, flags, "CAPABILITY_PROTECTED_VM", "protected-vm");
                addFlagCapability(manager.getClass(), probe, flags, "CAPABILITY_NON_PROTECTED_VM", "non-protected-vm");
                addFlagCapability(manager.getClass(), probe, flags, "CAPABILITY_REMOTE_ATTESTATION", "remote-attestation");
                return;
            }
            addBooleanCapability(capabilities, probe, "isProtectedVmSupported", "protected-vm");
            addBooleanCapability(capabilities, probe, "isVmSupported", "vm");
            addBooleanCapability(capabilities, probe, "isRemoteAttestationSupported", "remote-attestation");
        } catch (Throwable ignored) {
            // Capabilities methods vary by platform release; absence should not
            // make the feature probe itself fail.
        }
    }

    private static void addFlagCapability(
        Class<?> managerClass,
        Probe probe,
        int flags,
        String fieldName,
        String label
    ) {
        try {
            Field field = managerClass.getField(fieldName);
            int flag = field.getInt(null);
            if ((flags & flag) != 0) probe.capabilities.put(label);
        } catch (Throwable ignored) {
            // Optional capability constant.
        }
    }

    private static void addBooleanCapability(
        Object capabilities,
        Probe probe,
        String methodName,
        String label
    ) {
        try {
            Method method = capabilities.getClass().getMethod(methodName);
            Object value = method.invoke(capabilities);
            if (Boolean.TRUE.equals(value)) probe.capabilities.put(label);
        } catch (Throwable ignored) {
            // Optional capability.
        }
    }

    private static boolean declaresPermission(Context context, String permission) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(
                context.getPackageName(),
                PackageManager.GET_PERMISSIONS
            );
            String[] requested = info.requestedPermissions;
            if (requested == null) return false;
            for (String candidate : requested) {
                if (permission.equals(candidate)) return true;
            }
        } catch (Throwable ignored) {
            return false;
        }
        return false;
    }

    private static String error(String id, String code, String message, boolean retryable) {
        JSONObject root = new JSONObject();
        JSONObject error = new JSONObject();
        try {
            root.put("id", id);
            root.put("ok", false);
            error.put("code", code);
            error.put("message", message);
            error.put("retryable", retryable);
            root.put("error", error);
        } catch (Throwable ignored) {
            return "{\"id\":\"" + id + "\",\"ok\":false,\"error\":{\"code\":\""
                + code + "\",\"message\":\"" + message + "\",\"retryable\":false}}";
        }
        return root.toString();
    }
}
