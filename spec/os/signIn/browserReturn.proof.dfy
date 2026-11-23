// A filter that admits names exactly its one host and its one path, so leaving that host or path out leaves nothing.
lemma lawAnExtraHostOrPathNeverAdmits_ensures(f: CallbackFilter, host: string, path: string)
  ensures (lawAnExtraHostOrPathNeverAdmits(f, host, path) == true)
{
  if callbackFilterAdmits(f, host, path) {
    var ph := (set_x: string) => !((set_x in [host]));
    var pp := (set_x: string) => !((set_x in [path]));
    assert forall i :: 0 <= i < |f.hosts| ==> f.hosts[i] in f.hosts;
    assert forall i :: 0 <= i < |f.paths| ==> f.paths[i] in f.paths;
    ProofLib.FilterNone(ph, f.hosts);
    ProofLib.FilterNone(pp, f.paths);
  }
}
