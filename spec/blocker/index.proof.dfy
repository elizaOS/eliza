// spec/blocker/index.md, "A requested app is named by the id its device installed, whatever its letter case"
lemma BlockerInstalledAppIdWithLib(requested: string, folded: string, installed: seq<InstalledApp>)
  ensures installedAppId(requested, folded, installed) ==
    (var caseless := ProofLib.Filter((app: InstalledApp) => (app.foldedId == folded), installed);
     if (exists app :: app in installed && (app.appId == requested)) then requested
     else if (|caseless| == 1) then caseless[0].appId
     else requested)
{
}

lemma lawAnIdIsInstalledOrAsGiven_ensures(requested: string, folded: string, installed: seq<InstalledApp>)
  ensures (lawAnIdIsInstalledOrAsGiven(requested, folded, installed) == true)
{
  BlockerInstalledAppIdWithLib(requested, folded, installed);
  var p := (app: InstalledApp) => (app.foldedId == folded);
  var caseless := ProofLib.Filter(p, installed);
  ProofLib.FilterSamePredicate((app: InstalledApp) => (app.foldedId == folded), p, installed);
  if !(exists app :: app in installed && (app.appId == requested)) && |caseless| == 1 {
    var chosen := caseless[0];
    ProofLib.FilterMember(p, installed, chosen);
    assert chosen in installed && chosen.appId == installedAppId(requested, folded, installed) && chosen.foldedId == folded;
  }
}
