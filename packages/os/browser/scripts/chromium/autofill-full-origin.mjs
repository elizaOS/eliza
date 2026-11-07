// Browser-process origin transport; preserve the existing versioned consumer wire keys.
export function applyAutofillFullOrigin(edit, replaceOnce) {
  edit(
    "components/android_autofill/browser/java/src/org/chromium/components/autofill/FormData.java",
    (source) =>
      replaceOnce(
        source,
        "    public final int mSessionId;\n    public final String mName;\n    public final String mHost;\n    public final List<FormFieldData> mFields;\n\n    @VisibleForTesting\n",
        "    public final int mSessionId;\n    public final String mName;\n    public final String mHost;\n    public final String mMainFrameOrigin;\n    public final List<FormFieldData> mFields;\n\n    @VisibleForTesting\n",
        "Autofill full origin 1",
      ),
  );
  edit(
    "components/android_autofill/browser/java/src/org/chromium/components/autofill/FormData.java",
    (source) =>
      replaceOnce(
        source,
        '            int sessionId,\n            @JniType("std::u16string") String name,\n            @JniType("std::string") String origin,\n            @JniType("std::vector") List<FormFieldData> fields) {\n        return new FormData(sessionId, name, origin, fields);\n    }\n\n    public FormData(int sessionId, String name, String host, List<FormFieldData> fields) {\n        mSessionId = sessionId;\n        mName = name;\n        mHost = host;\n        mFields = fields;\n    }\n\n',
        '            int sessionId,\n            @JniType("std::u16string") String name,\n            @JniType("std::string") String origin,\n            @JniType("std::string") String mainFrameOrigin,\n            @JniType("std::vector") List<FormFieldData> fields) {\n        return new FormData(sessionId, name, origin, fields, mainFrameOrigin);\n    }\n\n    public FormData(int sessionId, String name, String host, List<FormFieldData> fields) {\n        this(sessionId, name, host, fields, "");\n    }\n\n    public FormData(int sessionId, String name, String host, List<FormFieldData> fields,\n            String mainFrameOrigin) {\n        mSessionId = sessionId;\n        mName = name;\n        mHost = host;\n        mMainFrameOrigin = mainFrameOrigin;\n        mFields = fields;\n    }\n\n',
        "Autofill full origin 2",
      ),
  );
  edit(
    "components/android_autofill/browser/java/src/org/chromium/components/autofill/FormData.java",
    (source) =>
      replaceOnce(
        source,
        '     */\n    public void fillViewStructure(ViewStructure structure, short focusFieldIndex) {\n        structure.setWebDomain(mHost);\n        structure.setHtmlInfo(\n                structure.newHtmlInfoBuilder("form").addAttribute("name", mName).build());\n        int index = structure.addChildCount(mFields.size());\n',
        '     */\n    public void fillViewStructure(ViewStructure structure, short focusFieldIndex) {\n        structure.setWebDomain(mHost);\n        // Browser-process origins survive Android\'s scheme/host-only setWebDomain.\n        // Never derive these values from DOM attributes or the form action URL.\n        structure.getExtras().putInt("ai.elizaresearch.autofill.version", 1);\n        structure.getExtras().putString("ai.elizaresearch.autofill.origin", mHost);\n        structure.getExtras().putString("ai.elizaresearch.autofill.topOrigin", mMainFrameOrigin);\n        structure.setHtmlInfo(\n                structure.newHtmlInfoBuilder("form").addAttribute("name", mName).build());\n        int index = structure.addChildCount(mFields.size());\n',
        "Autofill full origin 3",
      ),
  );
  edit(
    "components/android_autofill/browser/java/src/org/chromium/components/autofill/FormData.java",
    (source) =>
      replaceOnce(
        source,
        "            }\n            child.setHint(field.mPlaceholder);\n            child.setWebDomain(field.mOrigin);\n\n            RectF bounds = field.getBoundsInContainerViewCoordinates();\n            // Field has no scroll.\n",
        '            }\n            child.setHint(field.mPlaceholder);\n            child.setWebDomain(field.mOrigin);\n            child.getExtras().putString("ai.elizaresearch.autofill.fieldOrigin", field.mOrigin);\n\n            RectF bounds = field.getBoundsInContainerViewCoordinates();\n            // Field has no scroll.\n',
        "Autofill full origin 4",
      ),
  );
  edit(
    "components/android_autofill/browser/form_data_android_bridge_impl.cc",
    (source) =>
      replaceOnce(
        source,
        "  ScopedJavaLocalRef<jobject> obj = Java_FormData_createFormData(\n      env, session_id.value(), form.name(),\n      /*origin=*/\n      form.url().DeprecatedGetOriginAsURL().spec(), android_objects);\n  java_ref_ = JavaObjectWeakGlobalRef(env, obj);\n  return obj;\n}\n",
        "  ScopedJavaLocalRef<jobject> obj = Java_FormData_createFormData(\n      env, session_id.value(), form.name(),\n      /*origin=*/\n      form.url().DeprecatedGetOriginAsURL().spec(),\n      form.main_frame_origin().Serialize(), android_objects);\n  java_ref_ = JavaObjectWeakGlobalRef(env, obj);\n  return obj;\n}\n",
        "Autofill full origin 5",
      ),
  );
}
