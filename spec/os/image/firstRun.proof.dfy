lemma ImageRolesMember(request: os__image__provisioning_ProvisioningRequest, r: os__image__provisioning_DefaultRole)
  ensures r in os__image__provisioning_imageRoles(request) <==>
    r == os__image__provisioning_DefaultRole.HomeRole ||
    (os__image__provisioning_takesAssistant(request.assistant) && r == os__image__provisioning_DefaultRole.AssistantRole) ||
    (request.telephonyRoles && (r == os__image__provisioning_DefaultRole.DialerRole || r == os__image__provisioning_DefaultRole.SmsRole))
{
  var b := if os__image__provisioning_takesAssistant(request.assistant) then [os__image__provisioning_typed3_os__image__provisioning(os__image__provisioning_DefaultRole.AssistantRole)] else [];
  var c := if request.telephonyRoles then [os__image__provisioning_typed3_os__image__provisioning(os__image__provisioning_DefaultRole.DialerRole), os__image__provisioning_typed3_os__image__provisioning(os__image__provisioning_DefaultRole.SmsRole)] else [];
  ProofLib.FilterMember((set_x: os__image__provisioning_DefaultRole) => !((set_x in [os__image__provisioning_typed3_os__image__provisioning(os__image__provisioning_DefaultRole.HomeRole)])), b, r);
  ProofLib.FilterMember((set_x: os__image__provisioning_DefaultRole) => !((set_x in ([os__image__provisioning_typed3_os__image__provisioning(os__image__provisioning_DefaultRole.HomeRole)] + Std.Collections.Seq.Filter((set_x: os__image__provisioning_DefaultRole) => !((set_x in [os__image__provisioning_typed3_os__image__provisioning(os__image__provisioning_DefaultRole.HomeRole)])), (if os__image__provisioning_takesAssistant(request.assistant) then [os__image__provisioning_typed3_os__image__provisioning(os__image__provisioning_DefaultRole.AssistantRole)] else []))))), c, r);
}

lemma RequiredRolesMember(declared: seq<os__image__provisioning_DefaultRole>, telephony: bool, r: os__image__provisioning_DefaultRole)
  ensures r in requiredRoles(declared, telephony) <==>
    r == os__image__provisioning_DefaultRole.HomeRole ||
    (r in declared && (r.AssistantRole? || (telephony && (r.DialerRole? || r.SmsRole?))))
{
  var inner := ProofLib.Filter((r: os__image__provisioning_DefaultRole) => (r.AssistantRole? || (telephony && (r.DialerRole? || r.SmsRole?))), declared);
  ProofLib.FilterMember((r: os__image__provisioning_DefaultRole) => (r.AssistantRole? || (telephony && (r.DialerRole? || r.SmsRole?))), declared, r);
  ProofLib.FilterMember((set_x: os__image__provisioning_DefaultRole) => !((set_x in [typed0_os__image__firstRun(os__image__provisioning_DefaultRole.HomeRole)])), inner, r);
}

lemma lawRequiredRolesAreTheImageRolesNarrowedByTelephony_ensures(request: os__image__provisioning_ProvisioningRequest, telephony: bool)
  ensures (lawRequiredRolesAreTheImageRolesNarrowedByTelephony(request, telephony) == true)
{
  var declared := stagedDescriptor(request, true).roles;
  var local_0 := os__image__provisioning_imageRoles(request);
  var local_1 := requiredRoles(declared, telephony);
  ImageRolesMember(request, os__image__provisioning_DefaultRole.HomeRole);
  ImageRolesMember(request, os__image__provisioning_DefaultRole.AssistantRole);
  ImageRolesMember(request, os__image__provisioning_DefaultRole.DialerRole);
  ImageRolesMember(request, os__image__provisioning_DefaultRole.SmsRole);
  RequiredRolesMember(declared, telephony, os__image__provisioning_DefaultRole.HomeRole);
  RequiredRolesMember(declared, telephony, os__image__provisioning_DefaultRole.AssistantRole);
  RequiredRolesMember(declared, telephony, os__image__provisioning_DefaultRole.DialerRole);
  RequiredRolesMember(declared, telephony, os__image__provisioning_DefaultRole.SmsRole);
  forall set_x | set_x in local_1
    ensures set_x in local_0
  {
    RequiredRolesMember(declared, telephony, set_x);
    ImageRolesMember(request, set_x);
  }
}

lemma ConfirmedInProductWhenAssigning(confirmed: seq<os__image__provisioning_DefaultRole>, reading: Reading)
  requires !ownerChose(confirmed, reading) && |reading.unavailable| == 0
  ensures |reading.owner| == 0
  ensures forall x :: x in confirmed ==> x in reading.product
{
  forall x | x in confirmed
    ensures x in reading.product
  {
    ProofLib.FilterMember((set_x: os__image__provisioning_DefaultRole) => !((set_x in reading.unavailable)), confirmed, x);
  }
}

lemma lawOnlyARoleReadEmptyOrStockIsAssigned_ensures(required: seq<os__image__provisioning_DefaultRole>, confirmed: seq<os__image__provisioning_DefaultRole>, reading: Reading)
  ensures (lawOnlyARoleReadEmptyOrStockIsAssigned(required, confirmed, reading) == true)
{
  var a := attempted(required, confirmed, reading);
  var local_3 := a.assigning;
  if a.phase.Assigning? {
    ConfirmedInProductWhenAssigning(confirmed, reading);
    forall r | r in local_3
      ensures r in required && !(r in reading.unavailable) && !(r in reading.product) && !(r in reading.owner) && !(r in confirmed)
    {
      ProofLib.FilterMember((set_x: os__image__provisioning_DefaultRole) => !((set_x in reading.product)), required, r);
    }
  }
}

lemma AttemptedInv(required: seq<os__image__provisioning_DefaultRole>, confirmed: seq<os__image__provisioning_DefaultRole>, reading: Reading)
  requires typed0_os__image__firstRun(os__image__provisioning_DefaultRole.HomeRole) in required
  ensures alwaysAssignsOnlyRequiredRolesItNeverConfirmed(attempted(required, confirmed, reading))
  ensures alwaysDoneHoldsHomeAndEveryRequiredRole(attempted(required, confirmed, reading))
{
  var a := attempted(required, confirmed, reading);
  forall r | r in reading.product
    ensures r in a.confirmed
  {
    ProofLib.FilterMember((set_x: os__image__provisioning_DefaultRole) => !((set_x in confirmed)), reading.product, r);
  }
  if a.phase.Assigning? {
    ConfirmedInProductWhenAssigning(confirmed, reading);
    var missing :| missing in required && !(missing in reading.product);
    ProofLib.FilterMember((set_x: os__image__provisioning_DefaultRole) => !((set_x in reading.product)), required, missing);
    assert missing in a.assigning;
    forall r | r in a.assigning
      ensures r in required && !(r in a.confirmed)
    {
      ProofLib.FilterMember((set_x: os__image__provisioning_DefaultRole) => !((set_x in reading.product)), required, r);
      ProofLib.FilterMember((set_x: os__image__provisioning_DefaultRole) => !((set_x in confirmed)), reading.product, r);
    }
    forall i | 0 <= i < |a.assigning|
      ensures !(a.assigning[i] in a.confirmed)
    {
      assert a.assigning[i] in a.assigning;
    }
    ProofLib.FilterNone((set_x: os__image__provisioning_DefaultRole) => (set_x in a.confirmed), a.assigning);
  } else {
    ProofLib.FilterNil((set_x: os__image__provisioning_DefaultRole) => (set_x in a.confirmed), a.assigning);
  }
}

lemma AllAttemptedInv(required: seq<os__image__provisioning_DefaultRole>, reading: Reading)
  requires typed0_os__image__firstRun(os__image__provisioning_DefaultRole.HomeRole) in required
  ensures forall confirmed: seq<os__image__provisioning_DefaultRole> ::
    alwaysAssignsOnlyRequiredRolesItNeverConfirmed(attempted(required, confirmed, reading)) &&
    alwaysDoneHoldsHomeAndEveryRequiredRole(attempted(required, confirmed, reading))
{
  forall confirmed: seq<os__image__provisioning_DefaultRole>
    ensures alwaysAssignsOnlyRequiredRolesItNeverConfirmed(attempted(required, confirmed, reading))
    ensures alwaysDoneHoldsHomeAndEveryRequiredRole(attempted(required, confirmed, reading))
  {
    AttemptedInv(required, confirmed, reading);
  }
}

lemma begin_ensures(s: FirstRun, descriptor: Descriptor, device: Device, reading: Reading)
  ensures (inv(s) ==> canBegin(s, descriptor, device, reading) ==> alwaysAssignsOnlyRequiredRolesItNeverConfirmed(begin(s, descriptor, device, reading)))
  ensures (inv(s) ==> canBegin(s, descriptor, device, reading) ==> alwaysDoneHoldsHomeAndEveryRequiredRole(begin(s, descriptor, device, reading)))
  ensures (inv(s) ==> canBegin(s, descriptor, device, reading) ==> stepAssignsOnlyAtTheStartOfAnAttempt(s, "begin", begin(s, descriptor, device, reading)))
  ensures (inv(s) ==> canBegin(s, descriptor, device, reading) ==> stepDoneAndRetiredAreFinal(s, begin(s, descriptor, device, reading)))
{
  if inv(s) && canBegin(s, descriptor, device, reading) {
    if eligible(device) {
      var req := requiredRoles(descriptor.roles, device.telephony);
      assert typed0_os__image__firstRun(os__image__provisioning_DefaultRole.HomeRole) in req;
      AllAttemptedInv(req, reading);
    } else {
      ProofLib.FilterNil((set_x: os__image__provisioning_DefaultRole) => (set_x in s.confirmed), []);
    }
  }
}

lemma readBack_ensures(s: FirstRun, reading: Reading)
  ensures (inv(s) ==> canReadBack(s, reading) ==> alwaysAssignsOnlyRequiredRolesItNeverConfirmed(readBack(s, reading)))
  ensures (inv(s) ==> canReadBack(s, reading) ==> alwaysDoneHoldsHomeAndEveryRequiredRole(readBack(s, reading)))
  ensures (inv(s) ==> canReadBack(s, reading) ==> stepAssignsOnlyAtTheStartOfAnAttempt(s, "readBack", readBack(s, reading)))
  ensures (inv(s) ==> canReadBack(s, reading) ==> stepDoneAndRetiredAreFinal(s, readBack(s, reading)))
{
  if inv(s) && canReadBack(s, reading) {
    AttemptedInv(s.required, s.confirmed, reading);
    var after := readBack(s, reading);
    ProofLib.FilterNil((set_x: os__image__provisioning_DefaultRole) => (set_x in after.confirmed), []);
  }
}
