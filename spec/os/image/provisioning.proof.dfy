lemma lawOverridesEnableOnlyDisabledHandlers_ensures(manifest: LauncherManifest, request: ProvisioningRequest)
  ensures (lawOverridesEnableOnlyDisabledHandlers(manifest, request) == true)
{
  if provisioningDefaults(manifest, request).ProvisioningAdmitted? && request.telephonyRoles {
    ProofLib.FilterNone((h: RoleHandler) => !(handlerFits(manifest, h)), telephonyHandlers);
    var d := provisioningDefaults(manifest, request);
    forall n | n in d.overrides
      ensures exists c :: c in manifest.components && c.name == n && !c.enabledByDefault
    {
      var i :| 0 <= i < |telephonyHandlers| && d.overrides[i] == n;
      var h := telephonyHandlers[i];
      assert handlerFits(manifest, h);
      var m := handlerMatches(manifest, h);
      ProofLib.FilterMember((c: ManifestComponent) => (h.handles in c.handles), manifest.components, m[0]);
      assert m[0] in manifest.components && m[0].name == n && !m[0].enabledByDefault;
    }
  }
}

lemma lawEnabledHandlerIsRefused_ensures(manifest: LauncherManifest, request: ProvisioningRequest)
  ensures (lawEnabledHandlerIsRefused(manifest, request) == true)
{
  if request.telephonyRoles && provisioningAdmitted(provisioningDefaults(manifest, request)) {
    ProofLib.FilterNone((h: RoleHandler) => !(handlerFits(manifest, h)), telephonyHandlers);
    forall h | h in telephonyHandlers
      ensures !(exists c :: c in handlerMatches(manifest, h) && c.enabledByDefault)
    {
      assert handlerFits(manifest, h);
      var m := handlerMatches(manifest, h);
      assert |m| == 1 && !m[0].enabledByDefault;
    }
  }
}

lemma ImageRolesMember(request: ProvisioningRequest, r: DefaultRole)
  ensures r in imageRoles(request) <==>
    r == DefaultRole.HomeRole ||
    (takesAssistant(request.assistant) && r == DefaultRole.AssistantRole) ||
    (request.telephonyRoles && (r == DefaultRole.DialerRole || r == DefaultRole.SmsRole))
{
  var b := if takesAssistant(request.assistant) then [typed3_os__image__provisioning(DefaultRole.AssistantRole)] else [];
  var c := if request.telephonyRoles then [typed3_os__image__provisioning(DefaultRole.DialerRole), typed3_os__image__provisioning(DefaultRole.SmsRole)] else [];
  ProofLib.FilterMember((set_x: DefaultRole) => !((set_x in [typed3_os__image__provisioning(DefaultRole.HomeRole)])), b, r);
  ProofLib.FilterMember((set_x: DefaultRole) => !((set_x in ([typed3_os__image__provisioning(DefaultRole.HomeRole)] + Std.Collections.Seq.Filter((set_x: DefaultRole) => !((set_x in [typed3_os__image__provisioning(DefaultRole.HomeRole)])), (if takesAssistant(request.assistant) then [typed3_os__image__provisioning(DefaultRole.AssistantRole)] else []))))), c, r);
}

lemma lawDeclaredRolesHaveAdmittedHandlers_ensures(manifest: LauncherManifest, request: ProvisioningRequest)
  ensures (lawDeclaredRolesHaveAdmittedHandlers(manifest, request) == true)
{
  ImageRolesMember(request, DefaultRole.AssistantRole);
  ImageRolesMember(request, DefaultRole.DialerRole);
}

lemma lawActivationEnablesOnlyDisabledExportedActivities_ensures(manifest: LauncherManifest, request: ProvisioningRequest, staging: ListenerStaging)
  ensures (lawActivationEnablesOnlyDisabledExportedActivities(manifest, request, staging) == true)
{
  var act := listenerActivation(manifest, request, staging);
  if act.ActivationWritten? {
    var m := activitiesHandling(manifest, Handles.AssistIntent);
    ProofLib.FilterMember((c: ManifestComponent) => (c.kind.ActivityKind? && (Handles.AssistIntent in c.handles)), manifest.components, m[0]);
    assert m[0] in manifest.components;
  }
}
