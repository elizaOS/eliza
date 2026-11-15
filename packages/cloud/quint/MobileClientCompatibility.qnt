// One current registration and one explicitly declared installed-client alias.
// Authentication, grant acknowledgement, expiry and ownership are unchanged and
// remain in MobileAppCredential; this model covers registration selection only.
module MobileClientCompatibility {
  var present: bool
  var clientEnabled: bool
  var sameBinding: bool
  var chained: bool
  var accepted: bool
  action init = all {present'=false,clientEnabled'=true,sameBinding'=true,chained'=false,accepted'=false}
  action configure(p:bool,e:bool,b:bool,c:bool):bool = all {present'=p,clientEnabled'=e,sameBinding'=b,chained'=c,accepted'=false}
  action read = all {present'=present,clientEnabled'=clientEnabled,sameBinding'=sameBinding,chained'=chained,accepted'=(present and clientEnabled and sameBinding and not(chained))}
  action step = any {read,{nondet p=Bool.oneOf();nondet e=Bool.oneOf();nondet b=Bool.oneOf();nondet c=Bool.oneOf();configure(p,e,b,c)}}
  val safety = accepted implies (present and clientEnabled and sameBinding and not(chained))
  run renamedWithoutAliasRefusesTest = init.then(read).expect(not(accepted))
  run explicitMatchingAliasRestoresTest = init.then(configure(true,true,true,false)).then(read).expect(accepted)
  run differentAuthorityRefusesTest = init.then(configure(true,true,false,false)).then(read).expect(not(accepted))
  run disabledFamilyRefusesTest = init.then(configure(true,false,true,false)).then(read).expect(not(accepted))
  run aliasChainRefusesTest = init.then(configure(true,true,true,true)).then(read).expect(not(accepted))
}
