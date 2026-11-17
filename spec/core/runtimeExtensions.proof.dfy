// Proofs for spec/core/runtimeExtensions.md.
// alwaysUniqueKeys counts matches with a filter; the helpers below show that
// it is the same as "no two positions share a key" (ProofLib.DistinctBy), and
// each transition keeps that: replacing in place keeps every key, appending
// adds a key that was absent, and filtering only removes entries.

lemma WorkersUniqueIff(xs: seq<Worker>)
  ensures (!(exists w :: w in xs && !((|ProofLib.Filter((other: Worker) => (other.name == w.name), xs)| == 1)))) <==> ProofLib.DistinctBy(xs, (x: Worker) => x.name)
{
  if ProofLib.DistinctBy(xs, (x: Worker) => x.name) {
    forall w | w in xs
      ensures |ProofLib.Filter((other: Worker) => (other.name == w.name), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == w;
      ProofLib.FilterCountOneIffUnique((other: Worker) => (other.name == w.name), xs, (x: Worker) => x.name, i);
    }
  } else {
    var i, j :| 0 <= i < |xs| && 0 <= j < |xs| && i != j && xs[i].name == xs[j].name;
    var w := xs[i];
    ProofLib.FilterTwo((other: Worker) => (other.name == w.name), xs, i, j);
  }
}

lemma CategoriesUniqueIff(xs: seq<SearchCategory>)
  ensures (!(exists c :: c in xs && !((|ProofLib.Filter((other: SearchCategory) => (other.key == c.key), xs)| == 1)))) <==> ProofLib.DistinctBy(xs, (x: SearchCategory) => x.key)
{
  if ProofLib.DistinctBy(xs, (x: SearchCategory) => x.key) {
    forall c | c in xs
      ensures |ProofLib.Filter((other: SearchCategory) => (other.key == c.key), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == c;
      ProofLib.FilterCountOneIffUnique((other: SearchCategory) => (other.key == c.key), xs, (x: SearchCategory) => x.key, i);
    }
  } else {
    var i, j :| 0 <= i < |xs| && 0 <= j < |xs| && i != j && xs[i].key == xs[j].key;
    var c := xs[i];
    ProofLib.FilterTwo((other: SearchCategory) => (other.key == c.key), xs, i, j);
  }
}

lemma ProvidersUniqueIff(xs: seq<ResolvedProvider>)
  ensures (!(exists p :: p in xs && !((|ProofLib.Filter((other: ResolvedProvider) => (other.modelType == p.modelType), xs)| == 1)))) <==> ProofLib.DistinctBy(xs, (x: ResolvedProvider) => x.modelType)
{
  if ProofLib.DistinctBy(xs, (x: ResolvedProvider) => x.modelType) {
    forall p | p in xs
      ensures |ProofLib.Filter((other: ResolvedProvider) => (other.modelType == p.modelType), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == p;
      ProofLib.FilterCountOneIffUnique((other: ResolvedProvider) => (other.modelType == p.modelType), xs, (x: ResolvedProvider) => x.modelType, i);
    }
  } else {
    var i, j :| 0 <= i < |xs| && 0 <= j < |xs| && i != j && xs[i].modelType == xs[j].modelType;
    var p := xs[i];
    ProofLib.FilterTwo((other: ResolvedProvider) => (other.modelType == p.modelType), xs, i, j);
  }
}

lemma UniqueKeysIff(s: RuntimeExtensions)
  ensures alwaysUniqueKeys(s) <==> (ProofLib.DistinctBy(s.workers, (x: Worker) => x.name) && ProofLib.DistinctBy(s.categories, (x: SearchCategory) => x.key) && ProofLib.DistinctBy(s.providers, (x: ResolvedProvider) => x.modelType))
{
  WorkersUniqueIff(s.workers);
  CategoriesUniqueIff(s.categories);
  ProvidersUniqueIff(s.providers);
}

lemma RegisterWorkerKeepsDistinct(s: RuntimeExtensions, name: string, reference: int)
  requires ProofLib.DistinctBy(s.workers, (x: Worker) => x.name)
  ensures ProofLib.DistinctBy(registerWorker(s, name, reference).workers, (x: Worker) => x.name)
{
  var added := Worker(name, reference);
  if !(exists w :: w in s.workers && (w.name == name)) {
    ProofLib.DistinctByConcat(s.workers, [added], (x: Worker) => x.name);
  }
}

lemma RegisterCategoryKeepsDistinct(s: RuntimeExtensions, category: SearchCategory)
  requires ProofLib.DistinctBy(s.categories, (x: SearchCategory) => x.key)
  ensures ProofLib.DistinctBy(registerCategory(s, category).categories, (x: SearchCategory) => x.key)
{
  if !(exists c :: c in s.categories && (c.key == category.key)) {
    ProofLib.DistinctByConcat(s.categories, [category], (x: SearchCategory) => x.key);
  }
}

lemma UnregisterWorkerKeepsDistinct(s: RuntimeExtensions, name: string)
  requires ProofLib.DistinctBy(s.workers, (x: Worker) => x.name)
  ensures ProofLib.DistinctBy(unregisterWorker(s, name).workers, (x: Worker) => x.name)
{
  ProofLib.FilterKeepsDistinctBy((w: Worker) => (w.name != name), s.workers, (x: Worker) => x.name);
}

lemma NoteProviderKeepsDistinct(s: RuntimeExtensions, modelType: string, provider: string)
  requires ProofLib.DistinctBy(s.providers, (x: ResolvedProvider) => x.modelType)
  ensures ProofLib.DistinctBy(noteResolvedProvider(s, modelType, provider, true).providers, (x: ResolvedProvider) => x.modelType)
{
  var kept := ProofLib.Filter((p: ResolvedProvider) => (p.modelType != modelType), s.providers);
  var added := ResolvedProvider(modelType, provider);
  ProofLib.FilterKeepsDistinctBy((p: ResolvedProvider) => (p.modelType != modelType), s.providers, (x: ResolvedProvider) => x.modelType);
  ProofLib.DistinctByConcat(kept, [added], (x: ResolvedProvider) => x.modelType);
}

lemma registerWorker_ensures(s: RuntimeExtensions, name: string, reference: int)
  ensures (inv(s) ==> canRegisterWorker(s, name, reference) ==> alwaysUniqueKeys(registerWorker(s, name, reference)))
  ensures (inv(s) ==> canRegisterWorker(s, name, reference) ==> stepRegisterWorkerWakesScheduler(s, "registerWorker", registerWorker(s, name, reference)))
  ensures (inv(s) ==> canRegisterWorker(s, name, reference) ==> stepCategoryIsolation(s, "registerWorker", registerWorker(s, name, reference)))
{
  if inv(s) {
    UniqueKeysIff(s);
    RegisterWorkerKeepsDistinct(s, name, reference);
    UniqueKeysIff(registerWorker(s, name, reference));
  }
}

lemma unregisterWorker_ensures(s: RuntimeExtensions, name: string)
  ensures (inv(s) ==> alwaysUniqueKeys(unregisterWorker(s, name)))
  ensures (inv(s) ==> stepRegisterWorkerWakesScheduler(s, "unregisterWorker", unregisterWorker(s, name)))
  ensures (inv(s) ==> stepCategoryIsolation(s, "unregisterWorker", unregisterWorker(s, name)))
{
  if inv(s) {
    UniqueKeysIff(s);
    UnregisterWorkerKeepsDistinct(s, name);
    UniqueKeysIff(unregisterWorker(s, name));
  }
}

lemma registerCategory_ensures(s: RuntimeExtensions, category: SearchCategory)
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> alwaysUniqueKeys(registerCategory(s, category)))
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> stepRegisterWorkerWakesScheduler(s, "registerCategory", registerCategory(s, category)))
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> stepCategoryIsolation(s, "registerCategory", registerCategory(s, category)))
{
  if inv(s) {
    UniqueKeysIff(s);
    RegisterCategoryKeepsDistinct(s, category);
    UniqueKeysIff(registerCategory(s, category));
  }
}

lemma noteResolvedProvider_ensures(s: RuntimeExtensions, modelType: string, provider: string, nonblank: bool)
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, provider, nonblank) ==> alwaysUniqueKeys(noteResolvedProvider(s, modelType, provider, nonblank)))
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, provider, nonblank) ==> stepRegisterWorkerWakesScheduler(s, "noteResolvedProvider", noteResolvedProvider(s, modelType, provider, nonblank)))
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, provider, nonblank) ==> stepCategoryIsolation(s, "noteResolvedProvider", noteResolvedProvider(s, modelType, provider, nonblank)))
{
  if inv(s) && nonblank {
    UniqueKeysIff(s);
    NoteProviderKeepsDistinct(s, modelType, provider);
    UniqueKeysIff(noteResolvedProvider(s, modelType, provider, nonblank));
  }
}
