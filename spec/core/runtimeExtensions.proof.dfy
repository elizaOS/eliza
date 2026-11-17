lemma ExtensionsFilters(s: RuntimeExtensions)
  ensures alwaysUniqueKeys(s) == ((forall w :: w in s.workers ==> |ProofLib.Filter((other: Worker) => (other.name == w.name), s.workers)| == 1) && (forall c :: c in s.categories ==> |ProofLib.Filter((other: SearchCategory) => (other.key == c.key), s.categories)| == 1) && (forall p :: p in s.providers ==> |ProofLib.Filter((other: ResolvedProvider) => (other.modelType == p.modelType), s.providers)| == 1))
{}

lemma ExtensionWorkersDistinct(rows: seq<Worker>)
  ensures (forall row :: row in rows ==> |ProofLib.Filter((other: Worker) => (other.name == row.name), rows)| == 1) <==> ProofLib.DistinctBy(rows, (row: Worker) => row.name)
{
  if forall row :: row in rows ==> |ProofLib.Filter((other: Worker) => (other.name == row.name), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j
      ensures rows[i].name != rows[j].name
    {
      ProofLib.FilterCountOneIffUnique((other: Worker) => (other.name == rows[i].name), rows, (row: Worker) => row.name, i);
    }
  } else if ProofLib.DistinctBy(rows, (row: Worker) => row.name) {
    forall row | row in rows
      ensures |ProofLib.Filter((other: Worker) => (other.name == row.name), rows)| == 1
    {
      var i :| 0 <= i < |rows| && rows[i] == row;
      ProofLib.FilterOne((other: Worker) => (other.name == row.name), rows, i);
    }
  }
}

lemma ExtensionCategoriesDistinct(rows: seq<SearchCategory>)
  ensures (forall row :: row in rows ==> |ProofLib.Filter((other: SearchCategory) => (other.key == row.key), rows)| == 1) <==> ProofLib.DistinctBy(rows, (row: SearchCategory) => row.key)
{
  if forall row :: row in rows ==> |ProofLib.Filter((other: SearchCategory) => (other.key == row.key), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j
      ensures rows[i].key != rows[j].key
    {
      ProofLib.FilterCountOneIffUnique((other: SearchCategory) => (other.key == rows[i].key), rows, (row: SearchCategory) => row.key, i);
    }
  } else if ProofLib.DistinctBy(rows, (row: SearchCategory) => row.key) {
    forall row | row in rows
      ensures |ProofLib.Filter((other: SearchCategory) => (other.key == row.key), rows)| == 1
    {
      var i :| 0 <= i < |rows| && rows[i] == row;
      ProofLib.FilterOne((other: SearchCategory) => (other.key == row.key), rows, i);
    }
  }
}

lemma ExtensionProvidersDistinct(rows: seq<ResolvedProvider>)
  ensures (forall row :: row in rows ==> |ProofLib.Filter((other: ResolvedProvider) => (other.modelType == row.modelType), rows)| == 1) <==> ProofLib.DistinctBy(rows, (row: ResolvedProvider) => row.modelType)
{
  if forall row :: row in rows ==> |ProofLib.Filter((other: ResolvedProvider) => (other.modelType == row.modelType), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j
      ensures rows[i].modelType != rows[j].modelType
    {
      ProofLib.FilterCountOneIffUnique((other: ResolvedProvider) => (other.modelType == rows[i].modelType), rows, (row: ResolvedProvider) => row.modelType, i);
    }
  } else if ProofLib.DistinctBy(rows, (row: ResolvedProvider) => row.modelType) {
    forall row | row in rows
      ensures |ProofLib.Filter((other: ResolvedProvider) => (other.modelType == row.modelType), rows)| == 1
    {
      var i :| 0 <= i < |rows| && rows[i] == row;
      ProofLib.FilterOne((other: ResolvedProvider) => (other.modelType == row.modelType), rows, i);
    }
  }
}

lemma ExtensionUnregisterParts(s: RuntimeExtensions, name: string)
  ensures unregisterWorker(s, name) == s.(workers := ProofLib.Filter((w: Worker) => (w.name != name), s.workers))
{}

lemma ExtensionProviderParts(s: RuntimeExtensions, modelType: string, provider: string, nonblank: bool)
  ensures noteResolvedProvider(s, modelType, provider, nonblank) == (if !nonblank then s else s.(providers := ProofLib.Filter((p: ResolvedProvider) => (p.modelType != modelType), s.providers) + [ResolvedProvider(modelType, provider)]))
{}

lemma registerWorker_ensures(s: RuntimeExtensions, name: string, reference: int)
  ensures (inv(s) ==> canRegisterWorker(s, name, reference) ==> alwaysUniqueKeys(registerWorker(s, name, reference)))
  ensures (inv(s) ==> canRegisterWorker(s, name, reference) ==> stepRegisterWorkerWakesScheduler(s, "registerWorker", registerWorker(s, name, reference)))
  ensures (inv(s) ==> canRegisterWorker(s, name, reference) ==> stepCategoryIsolation(s, "registerWorker", registerWorker(s, name, reference)))
{
  if inv(s) && canRegisterWorker(s, name, reference) {
    var after := registerWorker(s, name, reference);
    ExtensionsFilters(s);
    ExtensionsFilters(after);
    ExtensionWorkersDistinct(s.workers);
    if exists w :: w in s.workers && w.name == name {
      assert |after.workers| == |s.workers|;
      forall i, j | 0 <= i < |after.workers| && 0 <= j < |after.workers| && i != j
        ensures after.workers[i].name != after.workers[j].name
      {
        assert after.workers[i].name == s.workers[i].name;
        assert after.workers[j].name == s.workers[j].name;
      }
    } else {
      ProofLib.DistinctByConcat(s.workers, [Worker(name, reference)], (row: Worker) => row.name);
    }
    ExtensionWorkersDistinct(after.workers);
  }
}

lemma unregisterWorker_ensures(s: RuntimeExtensions, name: string)
  ensures (inv(s) ==> alwaysUniqueKeys(unregisterWorker(s, name)))
  ensures (inv(s) ==> stepRegisterWorkerWakesScheduler(s, "unregisterWorker", unregisterWorker(s, name)))
  ensures (inv(s) ==> stepCategoryIsolation(s, "unregisterWorker", unregisterWorker(s, name)))
{
  if inv(s) {
    var after := unregisterWorker(s, name);
    ExtensionsFilters(s);
    ExtensionsFilters(after);
    ExtensionWorkersDistinct(s.workers);
    ExtensionUnregisterParts(s, name);
    ProofLib.FilterKeepsDistinctBy((w: Worker) => (w.name != name), s.workers, (row: Worker) => row.name);
    ExtensionWorkersDistinct(after.workers);
  }
}

lemma registerCategory_ensures(s: RuntimeExtensions, category: SearchCategory)
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> alwaysUniqueKeys(registerCategory(s, category)))
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> stepRegisterWorkerWakesScheduler(s, "registerCategory", registerCategory(s, category)))
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> stepCategoryIsolation(s, "registerCategory", registerCategory(s, category)))
{
  if inv(s) && canRegisterCategory(s, category) {
    var after := registerCategory(s, category);
    ExtensionsFilters(s);
    ExtensionsFilters(after);
    ExtensionCategoriesDistinct(s.categories);
    if exists c :: c in s.categories && c.key == category.key {
      assert |after.categories| == |s.categories|;
      forall i, j | 0 <= i < |after.categories| && 0 <= j < |after.categories| && i != j
        ensures after.categories[i].key != after.categories[j].key
      {
        assert after.categories[i].key == s.categories[i].key;
        assert after.categories[j].key == s.categories[j].key;
      }
    } else {
      ProofLib.DistinctByConcat(s.categories, [category], (row: SearchCategory) => row.key);
    }
    ExtensionCategoriesDistinct(after.categories);
  }
}

lemma noteResolvedProvider_ensures(s: RuntimeExtensions, modelType: string, provider: string, nonblank: bool)
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, provider, nonblank) ==> alwaysUniqueKeys(noteResolvedProvider(s, modelType, provider, nonblank)))
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, provider, nonblank) ==> stepRegisterWorkerWakesScheduler(s, "noteResolvedProvider", noteResolvedProvider(s, modelType, provider, nonblank)))
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, provider, nonblank) ==> stepCategoryIsolation(s, "noteResolvedProvider", noteResolvedProvider(s, modelType, provider, nonblank)))
{
  if inv(s) && canNoteResolvedProvider(s, modelType, provider, nonblank) && nonblank {
    var after := noteResolvedProvider(s, modelType, provider, nonblank);
    ExtensionsFilters(s);
    ExtensionsFilters(after);
    ExtensionProvidersDistinct(s.providers);
    ExtensionProviderParts(s, modelType, provider, nonblank);
    var keep := (p: ResolvedProvider) => (p.modelType != modelType);
    var kept := ProofLib.Filter(keep, s.providers);
    ProofLib.FilterKeepsDistinctBy(keep, s.providers, (row: ResolvedProvider) => row.modelType);
    forall entry | entry in kept ensures entry.modelType != modelType {
      ProofLib.FilterMember(keep, s.providers, entry);
    }
    ProofLib.DistinctByConcat(kept, [ResolvedProvider(modelType, provider)], (row: ResolvedProvider) => row.modelType);
    ExtensionProvidersDistinct(after.providers);
  }
}
