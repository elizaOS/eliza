const __vite__mapDeps = (
  i,
  m = __vite__mapDeps,
  d = m.f || (m.f = ['./assets/xtermModule-BoAIEibi.js', './xtermModule.Beg8tuEN.css'])
) => i.map((i) => d[i]);
import {
  u as Lt,
  r as K,
  e as Mt,
  _ as Dt,
  f as Ft,
  g as Ot,
  j as o,
  R as u,
  E as Ut,
  s as vt,
  h as at,
  i as Wt,
  t as At,
  m as zt,
  k as Y,
  T as D,
  b as Vt,
  M as Kt,
  l as $t,
  a as Ht,
  W as qt,
  L as Yt,
  S as Qt,
  D as Xt,
  c as Jt,
  d as Zt,
} from './assets/defaultSettingsView-DTenqiGw.js';
var Gt = {};
class ot {
  constructor(t, e = {}) {
    (this.isListing = !1),
      (this._tests = new Map()),
      (this._rootSuite = new Q('', 'root')),
      (this._options = e),
      (this._reporter = t);
  }
  reset() {
    (this._rootSuite._entries = []), this._tests.clear();
  }
  dispatch(t) {
    const { method: e, params: s } = t;
    if (e === 'onConfigure') {
      this._onConfigure(s.config);
      return;
    }
    if (e === 'onProject') {
      this._onProject(s.project);
      return;
    }
    if (e === 'onBegin') {
      this._onBegin();
      return;
    }
    if (e === 'onTestBegin') {
      this._onTestBegin(s.testId, s.result);
      return;
    }
    if (e === 'onTestEnd') {
      this._onTestEnd(s.test, s.result);
      return;
    }
    if (e === 'onStepBegin') {
      this._onStepBegin(s.testId, s.resultId, s.step);
      return;
    }
    if (e === 'onStepEnd') {
      this._onStepEnd(s.testId, s.resultId, s.step);
      return;
    }
    if (e === 'onError') {
      this._onError(s.error);
      return;
    }
    if (e === 'onStdIO') {
      this._onStdIO(s.type, s.testId, s.resultId, s.data, s.isBase64);
      return;
    }
    if (e === 'onEnd') return this._onEnd(s.result);
    if (e === 'onExit') return this._onExit();
  }
  _onConfigure(t) {
    var e, s;
    (this._rootDir = t.rootDir),
      (this._config = this._parseConfig(t)),
      (s = (e = this._reporter).onConfigure) == null || s.call(e, this._config);
  }
  _onProject(t) {
    let e = this._options.mergeProjects
      ? this._rootSuite.suites.find((s) => s.project().name === t.name)
      : void 0;
    e || ((e = new Q(t.name, 'project')), this._rootSuite._addSuite(e)),
      (e._project = this._parseProject(t));
    for (const s of t.suites) this._mergeSuiteInto(s, e);
  }
  _onBegin() {
    var t, e;
    (e = (t = this._reporter).onBegin) == null || e.call(t, this._rootSuite);
  }
  _onTestBegin(t, e) {
    var c, a;
    const s = this._tests.get(t);
    this._options.clearPreviousResultsWhenTestBegins && (s.results = []);
    const r = s._createTestResult(e.id);
    (r.retry = e.retry),
      (r.workerIndex = e.workerIndex),
      (r.parallelIndex = e.parallelIndex),
      r.setStartTimeNumber(e.startTime),
      (a = (c = this._reporter).onTestBegin) == null || a.call(c, s, r);
  }
  _onTestEnd(t, e) {
    var c, a, g;
    const s = this._tests.get(t.testId);
    (s.timeout = t.timeout), (s.expectedStatus = t.expectedStatus), (s.annotations = t.annotations);
    const r = s.results.find((l) => l._id === e.id);
    (r.duration = e.duration),
      (r.status = e.status),
      (r.errors = e.errors),
      (r.error = (c = r.errors) == null ? void 0 : c[0]),
      (r.attachments = this._parseAttachments(e.attachments)),
      (g = (a = this._reporter).onTestEnd) == null || g.call(a, s, r),
      (r._stepMap = new Map());
  }
  _onStepBegin(t, e, s) {
    var _, n;
    const r = this._tests.get(t),
      c = r.results.find((h) => h._id === e),
      a = s.parentStepId ? c._stepMap.get(s.parentStepId) : void 0,
      g = this._absoluteLocation(s.location),
      l = new ee(s, a, g, c);
    a ? a.steps.push(l) : c.steps.push(l),
      c._stepMap.set(s.id, l),
      (n = (_ = this._reporter).onStepBegin) == null || n.call(_, r, c, l);
  }
  _onStepEnd(t, e, s) {
    var g, l;
    const r = this._tests.get(t),
      c = r.results.find((_) => _._id === e),
      a = c._stepMap.get(s.id);
    (a._endPayload = s),
      (a.duration = s.duration),
      (a.error = s.error),
      (l = (g = this._reporter).onStepEnd) == null || l.call(g, r, c, a);
  }
  _onError(t) {
    var e, s;
    (s = (e = this._reporter).onError) == null || s.call(e, t);
  }
  _onStdIO(t, e, s, r, c) {
    var _, n, h, v;
    const a = c ? (globalThis.Buffer ? Buffer.from(r, 'base64') : atob(r)) : r,
      g = e ? this._tests.get(e) : void 0,
      l = g && s ? g.results.find((d) => d._id === s) : void 0;
    t === 'stdout'
      ? (l == null || l.stdout.push(a),
        (n = (_ = this._reporter).onStdOut) == null || n.call(_, a, g, l))
      : (l == null || l.stderr.push(a),
        (v = (h = this._reporter).onStdErr) == null || v.call(h, a, g, l));
  }
  async _onEnd(t) {
    var e, s;
    await ((s = (e = this._reporter).onEnd) == null
      ? void 0
      : s.call(e, { status: t.status, startTime: new Date(t.startTime), duration: t.duration }));
  }
  _onExit() {
    var t, e;
    return (e = (t = this._reporter).onExit) == null ? void 0 : e.call(t);
  }
  _parseConfig(t) {
    const e = { ...ie, ...t };
    return (
      this._options.configOverrides &&
        ((e.configFile = this._options.configOverrides.configFile),
        (e.reportSlowTests = this._options.configOverrides.reportSlowTests),
        (e.quiet = this._options.configOverrides.quiet),
        (e.reporter = [...this._options.configOverrides.reporter])),
      e
    );
  }
  _parseProject(t) {
    return {
      metadata: t.metadata,
      name: t.name,
      outputDir: this._absolutePath(t.outputDir),
      repeatEach: t.repeatEach,
      retries: t.retries,
      testDir: this._absolutePath(t.testDir),
      testIgnore: st(t.testIgnore),
      testMatch: st(t.testMatch),
      timeout: t.timeout,
      grep: st(t.grep),
      grepInvert: st(t.grepInvert),
      dependencies: t.dependencies,
      teardown: t.teardown,
      snapshotDir: this._absolutePath(t.snapshotDir),
      use: t.use,
    };
  }
  _parseAttachments(t) {
    return t.map((e) => ({
      ...e,
      body: e.base64 && globalThis.Buffer ? Buffer.from(e.base64, 'base64') : void 0,
    }));
  }
  _mergeSuiteInto(t, e) {
    let s = e.suites.find((r) => r.title === t.title);
    s || ((s = new Q(t.title, e.type === 'project' ? 'file' : 'describe')), e._addSuite(s)),
      (s.location = this._absoluteLocation(t.location)),
      t.entries.forEach((r) => {
        'testId' in r ? this._mergeTestInto(r, s) : this._mergeSuiteInto(r, s);
      });
  }
  _mergeTestInto(t, e) {
    let s = this._options.mergeTestCases
      ? e.tests.find((r) => r.title === t.title && r.repeatEachIndex === t.repeatEachIndex)
      : void 0;
    s ||
      ((s = new te(t.testId, t.title, this._absoluteLocation(t.location), t.repeatEachIndex)),
      e._addTest(s),
      this._tests.set(s.id, s)),
      this._updateTest(t, s);
  }
  _updateTest(t, e) {
    return (
      (e.id = t.testId),
      (e.location = this._absoluteLocation(t.location)),
      (e.retries = t.retries),
      (e.tags = t.tags ?? []),
      (e.annotations = t.annotations ?? []),
      e
    );
  }
  _absoluteLocation(t) {
    return t && { ...t, file: this._absolutePath(t.file) };
  }
  _absolutePath(t) {
    if (t !== void 0)
      return this._options.resolvePath
        ? this._options.resolvePath(this._rootDir, t)
        : this._rootDir + '/' + t;
  }
}
class Q {
  constructor(t, e) {
    (this._entries = []),
      (this._requireFile = ''),
      (this._parallelMode = 'none'),
      (this.title = t),
      (this._type = e);
  }
  get type() {
    return this._type;
  }
  get suites() {
    return this._entries.filter((t) => t.type !== 'test');
  }
  get tests() {
    return this._entries.filter((t) => t.type === 'test');
  }
  entries() {
    return this._entries;
  }
  allTests() {
    const t = [],
      e = (s) => {
        for (const r of s.entries()) r.type === 'test' ? t.push(r) : e(r);
      };
    return e(this), t;
  }
  titlePath() {
    const t = this.parent ? this.parent.titlePath() : [];
    return (this.title || this._type !== 'describe') && t.push(this.title), t;
  }
  project() {
    var t;
    return this._project ?? ((t = this.parent) == null ? void 0 : t.project());
  }
  _addTest(t) {
    (t.parent = this), this._entries.push(t);
  }
  _addSuite(t) {
    (t.parent = this), this._entries.push(t);
  }
}
class te {
  constructor(t, e, s, r) {
    (this.fn = () => {}),
      (this.results = []),
      (this.type = 'test'),
      (this.expectedStatus = 'passed'),
      (this.timeout = 0),
      (this.annotations = []),
      (this.retries = 0),
      (this.tags = []),
      (this.repeatEachIndex = 0),
      (this.id = t),
      (this.title = e),
      (this.location = s),
      (this.repeatEachIndex = r);
  }
  titlePath() {
    const t = this.parent ? this.parent.titlePath() : [];
    return t.push(this.title), t;
  }
  outcome() {
    return re(this);
  }
  ok() {
    const t = this.outcome();
    return t === 'expected' || t === 'flaky' || t === 'skipped';
  }
  _createTestResult(t) {
    const e = new se(this.results.length, t);
    return this.results.push(e), e;
  }
}
class ee {
  constructor(t, e, s, r) {
    (this.duration = -1),
      (this.steps = []),
      (this._startTime = 0),
      (this.title = t.title),
      (this.category = t.category),
      (this.location = s),
      (this.parent = e),
      (this._startTime = t.startTime),
      (this._result = r);
  }
  titlePath() {
    var e;
    return [...(((e = this.parent) == null ? void 0 : e.titlePath()) || []), this.title];
  }
  get startTime() {
    return new Date(this._startTime);
  }
  set startTime(t) {
    this._startTime = +t;
  }
  get attachments() {
    var t, e;
    return (
      ((e = (t = this._endPayload) == null ? void 0 : t.attachments) == null
        ? void 0
        : e.map((s) => this._result.attachments[s])) ?? []
    );
  }
  get annotations() {
    var t;
    return ((t = this._endPayload) == null ? void 0 : t.annotations) ?? [];
  }
}
class se {
  constructor(t, e) {
    (this.parallelIndex = -1),
      (this.workerIndex = -1),
      (this.duration = -1),
      (this.stdout = []),
      (this.stderr = []),
      (this.attachments = []),
      (this.status = 'skipped'),
      (this.steps = []),
      (this.errors = []),
      (this._stepMap = new Map()),
      (this._startTime = 0),
      (this.retry = t),
      (this._id = e);
  }
  setStartTimeNumber(t) {
    this._startTime = t;
  }
  get startTime() {
    return new Date(this._startTime);
  }
  set startTime(t) {
    this._startTime = +t;
  }
}
const ie = {
  forbidOnly: !1,
  fullyParallel: !1,
  globalSetup: null,
  globalTeardown: null,
  globalTimeout: 0,
  grep: /.*/,
  grepInvert: null,
  maxFailures: 0,
  metadata: {},
  preserveOutput: 'always',
  projects: [],
  reporter: [[Gt.CI ? 'dot' : 'list']],
  reportSlowTests: { max: 5, threshold: 3e5 },
  configFile: '',
  rootDir: '',
  quiet: !1,
  shard: null,
  updateSnapshots: 'missing',
  updateSourceMethod: 'patch',
  version: '',
  workers: 0,
  webServer: null,
};
function st(i) {
  return i.map((t) => (t.s !== void 0 ? t.s : new RegExp(t.r.source, t.r.flags)));
}
function re(i) {
  let t = 0,
    e = 0,
    s = 0;
  for (const r of i.results)
    r.status === 'interrupted' ||
      (r.status === 'skipped' && i.expectedStatus === 'skipped'
        ? ++t
        : r.status === 'skipped' || (r.status === i.expectedStatus ? ++e : ++s));
  return e === 0 && s === 0
    ? 'skipped'
    : s === 0
      ? 'expected'
      : e === 0 && t === 0
        ? 'unexpected'
        : 'flaky';
}
class nt {
  constructor(t, e, s, r, c) {
    (this._treeItemById = new Map()), (this._treeItemByTestId = new Map());
    const a = r && [...r.values()].some(Boolean);
    (this.pathSeparator = c),
      (this.rootItem = {
        kind: 'group',
        subKind: 'folder',
        id: t,
        title: '',
        location: { file: '', line: 0, column: 0 },
        duration: 0,
        parent: void 0,
        children: [],
        status: 'none',
        hasLoadErrors: !1,
      }),
      this._treeItemById.set(t, this.rootItem);
    const g = (l, _, n) => {
      for (const h of _.suites) {
        if (!h.title) {
          g(l, h, n);
          continue;
        }
        let v = n.children.find((d) => d.kind === 'group' && d.title === h.title);
        v ||
          ((v = {
            kind: 'group',
            subKind: 'describe',
            id: 'suite:' + _.titlePath().join('') + '' + h.title,
            title: h.title,
            location: h.location,
            duration: 0,
            parent: n,
            children: [],
            status: 'none',
            hasLoadErrors: !1,
          }),
          this._addChild(n, v)),
          g(l, h, v);
      }
      for (const h of _.tests) {
        const v = h.title;
        let d = n.children.find((C) => C.kind !== 'group' && C.title === v);
        d ||
          ((d = {
            kind: 'case',
            id: 'test:' + h.titlePath().join(''),
            title: v,
            parent: n,
            children: [],
            tests: [],
            location: h.location,
            duration: 0,
            status: 'none',
            project: void 0,
            test: void 0,
            tags: h.tags,
          }),
          this._addChild(n, d));
        const S = h.results[0];
        let x = 'none';
        (S == null ? void 0 : S[X]) === 'scheduled'
          ? (x = 'scheduled')
          : (S == null ? void 0 : S[X]) === 'running'
            ? (x = 'running')
            : (S == null ? void 0 : S.status) === 'skipped'
              ? (x = 'skipped')
              : (S == null ? void 0 : S.status) === 'interrupted'
                ? (x = 'none')
                : S && h.outcome() !== 'expected'
                  ? (x = 'failed')
                  : S && h.outcome() === 'expected' && (x = 'passed'),
          d.tests.push(h);
        const B = {
          kind: 'test',
          id: h.id,
          title: l.name,
          location: h.location,
          test: h,
          parent: d,
          children: [],
          status: x,
          duration: h.results.length ? Math.max(0, h.results[0].duration) : 0,
          project: l,
        };
        this._addChild(d, B),
          this._treeItemByTestId.set(h.id, B),
          (d.duration = d.children.reduce((C, j) => C + j.duration, 0));
      }
    };
    for (const l of (e == null ? void 0 : e.suites) || [])
      if (!(a && !r.get(l.title)))
        for (const _ of l.suites) {
          const n = this._fileItem(_.location.file.split(c), !0);
          g(l.project(), _, n);
        }
    for (const l of s) {
      if (!l.location) continue;
      const _ = this._fileItem(l.location.file.split(c), !0);
      _.hasLoadErrors = !0;
    }
  }
  _addChild(t, e) {
    t.children.push(e), (e.parent = t), this._treeItemById.set(e.id, e);
  }
  filterTree(t, e, s) {
    const r = t.trim().toLowerCase().split(' '),
      c = [...e.values()].some(Boolean),
      a = (l) => {
        const _ = [...l.tests[0].titlePath(), ...l.tests[0].tags].join(' ').toLowerCase();
        return !r.every((n) => _.includes(n)) &&
          !l.tests.some((n) => (s == null ? void 0 : s.has(n.id)))
          ? !1
          : ((l.children = l.children.filter(
              (n) => !c || (s == null ? void 0 : s.has(n.test.id)) || e.get(n.status)
            )),
            (l.tests = l.children.map((n) => n.test)),
            !!l.children.length);
      },
      g = (l) => {
        const _ = [];
        for (const n of l.children)
          n.kind === 'case'
            ? a(n) && _.push(n)
            : (g(n), (n.children.length || n.hasLoadErrors) && _.push(n));
        l.children = _;
      };
    g(this.rootItem);
  }
  _fileItem(t, e) {
    if (t.length === 0) return this.rootItem;
    const s = t.join(this.pathSeparator),
      r = this._treeItemById.get(s);
    if (r) return r;
    const c = this._fileItem(t.slice(0, t.length - 1), !1),
      a = {
        kind: 'group',
        subKind: e ? 'file' : 'folder',
        id: s,
        title: t[t.length - 1],
        location: { file: s, line: 0, column: 0 },
        duration: 0,
        parent: c,
        children: [],
        status: 'none',
        hasLoadErrors: !1,
      };
    return this._addChild(c, a), a;
  }
  sortAndPropagateStatus() {
    St(this.rootItem);
  }
  flattenForSingleProject() {
    const t = (e) => {
      e.kind === 'case' && e.children.length === 1
        ? ((e.project = e.children[0].project),
          (e.test = e.children[0].test),
          (e.children = []),
          this._treeItemByTestId.set(e.test.id, e))
        : e.children.forEach(t);
    };
    t(this.rootItem);
  }
  shortenRoot() {
    let t = this.rootItem;
    for (
      ;
      t.children.length === 1 &&
      t.children[0].kind === 'group' &&
      t.children[0].subKind === 'folder';

    )
      t = t.children[0];
    (t.location = this.rootItem.location), (this.rootItem = t);
  }
  testIds() {
    const t = new Set(),
      e = (s) => {
        s.kind === 'case' && s.tests.forEach((r) => t.add(r.id)), s.children.forEach(e);
      };
    return e(this.rootItem), t;
  }
  fileNames() {
    const t = new Set(),
      e = (s) => {
        s.kind === 'group' && s.subKind === 'file' ? t.add(s.id) : s.children.forEach(e);
      };
    return e(this.rootItem), [...t];
  }
  flatTreeItems() {
    const t = [],
      e = (s) => {
        t.push(s), s.children.forEach(e);
      };
    return e(this.rootItem), t;
  }
  treeItemById(t) {
    return this._treeItemById.get(t);
  }
  collectTestIds(t) {
    return t ? oe(t) : new Set();
  }
}
function St(i) {
  for (const a of i.children) St(a);
  i.kind === 'group' &&
    i.children.sort(
      (a, g) => a.location.file.localeCompare(g.location.file) || a.location.line - g.location.line
    );
  let t = i.children.length > 0,
    e = i.children.length > 0,
    s = !1,
    r = !1,
    c = !1;
  for (const a of i.children)
    (e = e && a.status === 'skipped'),
      (t = t && (a.status === 'passed' || a.status === 'skipped')),
      (s = s || a.status === 'failed'),
      (r = r || a.status === 'running'),
      (c = c || a.status === 'scheduled');
  r
    ? (i.status = 'running')
    : c
      ? (i.status = 'scheduled')
      : s
        ? (i.status = 'failed')
        : e
          ? (i.status = 'skipped')
          : t && (i.status = 'passed');
}
function oe(i) {
  const t = new Set(),
    e = (s) => {
      var r;
      s.kind === 'case'
        ? s.tests.map((c) => c.id).forEach((c) => t.add(c))
        : s.kind === 'test'
          ? t.add(s.id)
          : (r = s.children) == null || r.forEach(e);
    };
  return e(i), t;
}
const X = Symbol('statusEx');
class ne {
  constructor(t) {
    (this.loadErrors = []),
      (this.progress = { total: 0, passed: 0, failed: 0, skipped: 0 }),
      (this._lastRunTestCount = 0),
      (this._receiver = new ot(this._createReporter(), {
        mergeProjects: !0,
        mergeTestCases: !0,
        resolvePath: (e, s) => e + t.pathSeparator + s,
        clearPreviousResultsWhenTestBegins: !0,
      })),
      (this._options = t);
  }
  _createReporter() {
    return {
      version: () => 'v2',
      onConfigure: (t) => {
        (this.config = t),
          (this._lastRunReceiver = new ot(
            {
              version: () => 'v2',
              onBegin: (e) => {
                (this._lastRunTestCount = e.allTests().length), (this._lastRunReceiver = void 0);
              },
            },
            {
              mergeProjects: !0,
              mergeTestCases: !1,
              resolvePath: (e, s) => e + this._options.pathSeparator + s,
            }
          ));
      },
      onBegin: (t) => {
        var e;
        if ((this.rootSuite || (this.rootSuite = t), this._testResultsSnapshot)) {
          for (const s of this.rootSuite.allTests())
            s.results =
              ((e = this._testResultsSnapshot) == null ? void 0 : e.get(s.id)) || s.results;
          this._testResultsSnapshot = void 0;
        }
        (this.progress.total = this._lastRunTestCount),
          (this.progress.passed = 0),
          (this.progress.failed = 0),
          (this.progress.skipped = 0),
          this._options.onUpdate(!0);
      },
      onEnd: () => {
        this._options.onUpdate(!0);
      },
      onTestBegin: (t, e) => {
        (e[X] = 'running'), this._options.onUpdate();
      },
      onTestEnd: (t, e) => {
        t.outcome() === 'skipped'
          ? ++this.progress.skipped
          : t.outcome() === 'unexpected'
            ? ++this.progress.failed
            : ++this.progress.passed,
          (e[X] = e.status),
          this._options.onUpdate();
      },
      onError: (t) => this._handleOnError(t),
      printsToStdio: () => !1,
    };
  }
  processGlobalReport(t) {
    const e = new ot({
      version: () => 'v2',
      onConfigure: (s) => {
        this.config = s;
      },
      onError: (s) => this._handleOnError(s),
    });
    for (const s of t) e.dispatch(s);
  }
  processListReport(t) {
    var s;
    const e = ((s = this.rootSuite) == null ? void 0 : s.allTests()) || [];
    (this._testResultsSnapshot = new Map(e.map((r) => [r.id, r.results]))), this._receiver.reset();
    for (const r of t) this._receiver.dispatch(r);
  }
  processTestReportEvent(t) {
    var e, s, r;
    (s = (e = this._lastRunReceiver) == null ? void 0 : e.dispatch(t)) == null || s.catch(() => {}),
      (r = this._receiver.dispatch(t)) == null || r.catch(() => {});
  }
  _handleOnError(t) {
    var e, s;
    this.loadErrors.push(t),
      (s = (e = this._options).onError) == null || s.call(e, t),
      this._options.onUpdate();
  }
  asModel() {
    return {
      rootSuite: this.rootSuite || new Q('', 'root'),
      config: this.config,
      loadErrors: this.loadErrors,
      progress: this.progress,
    };
  }
}
const ae = ({ source: i }) => {
    const [t, e] = Lt(),
      [s, r] = K.useState(Mt()),
      [c] = K.useState(
        Dt(
          () => import('./assets/xtermModule-BoAIEibi.js'),
          __vite__mapDeps([0, 1]),
          import.meta.url
        ).then((g) => g.default)
      ),
      a = K.useRef(null);
    return (
      K.useEffect(() => (Ft(r), () => Ot(r)), []),
      K.useEffect(() => {
        const g = i.write,
          l = i.clear;
        return (
          (async () => {
            const { Terminal: _, FitAddon: n } = await c,
              h = e.current;
            if (!h) return;
            const v = s === 'dark-mode' ? ce : le;
            if (a.current && a.current.terminal.options.theme === v) return;
            a.current && (h.textContent = '');
            const d = new _({
                convertEol: !0,
                fontSize: 13,
                scrollback: 1e4,
                fontFamily: 'var(--vscode-editor-font-family)',
                theme: v,
              }),
              S = new n();
            d.loadAddon(S);
            for (const x of i.pending) d.write(x);
            (i.write = (x) => {
              i.pending.push(x), d.write(x);
            }),
              (i.clear = () => {
                (i.pending = []), d.clear();
              }),
              d.open(h),
              S.fit(),
              (a.current = { terminal: d, fitAddon: S });
          })(),
          () => {
            (i.clear = l), (i.write = g);
          }
        );
      }, [c, a, e, i, s]),
      K.useEffect(() => {
        setTimeout(() => {
          a.current &&
            (a.current.fitAddon.fit(), i.resize(a.current.terminal.cols, a.current.terminal.rows));
        }, 250);
      }, [t, i]),
      o.jsx('div', {
        'data-testid': 'output',
        className: 'xterm-wrapper',
        style: { flex: 'auto' },
        ref: e,
      })
    );
  },
  le = {
    foreground: '#383a42',
    background: '#fafafa',
    cursor: '#383a42',
    black: '#000000',
    red: '#e45649',
    green: '#50a14f',
    yellow: '#c18401',
    blue: '#4078f2',
    magenta: '#a626a4',
    cyan: '#0184bc',
    white: '#a0a0a0',
    brightBlack: '#000000',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#d19a66',
    brightBlue: '#4078f2',
    brightMagenta: '#a626a4',
    brightCyan: '#0184bc',
    brightWhite: '#383a42',
    selectionBackground: '#d7d7d7',
    selectionForeground: '#383a42',
  },
  ce = {
    foreground: '#f8f8f2',
    background: '#1e1e1e',
    cursor: '#f8f8f0',
    black: '#000000',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#bfbfbf',
    brightBlack: '#4d4d4d',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#e6e6e6',
    selectionBackground: '#44475a',
    selectionForeground: '#f8f8f2',
  },
  de = ({
    filterText: i,
    setFilterText: t,
    statusFilters: e,
    setStatusFilters: s,
    projectFilters: r,
    setProjectFilters: c,
    testModel: a,
    runTests: g,
  }) => {
    const [l, _] = u.useState(!1),
      n = u.useRef(null);
    u.useEffect(() => {
      var d;
      (d = n.current) == null || d.focus();
    }, []);
    const h =
        [...e.entries()]
          .filter(([d, S]) => S)
          .map(([d]) => d)
          .join(' ') || 'all',
      v =
        [...r.entries()]
          .filter(([d, S]) => S)
          .map(([d]) => d)
          .join(' ') || 'all';
    return o.jsxs('div', {
      className: 'filters',
      children: [
        o.jsx(Ut, {
          expanded: l,
          setExpanded: _,
          title: o.jsx('input', {
            ref: n,
            type: 'search',
            placeholder: 'Filter (e.g. text, @tag)',
            spellCheck: !1,
            value: i,
            onChange: (d) => {
              t(d.target.value);
            },
            onKeyDown: (d) => {
              d.key === 'Enter' && g();
            },
          }),
        }),
        o.jsxs('div', {
          className: 'filter-summary',
          title:
            'Status: ' +
            h +
            `
Projects: ` +
            v,
          onClick: () => _(!l),
          children: [
            o.jsx('span', { className: 'filter-label', children: 'Status:' }),
            ' ',
            h,
            o.jsx('span', { className: 'filter-label', children: 'Projects:' }),
            ' ',
            v,
          ],
        }),
        l &&
          o.jsxs('div', {
            className: 'hbox',
            style: { marginLeft: 14, maxHeight: 200, overflowY: 'auto' },
            children: [
              o.jsx('div', {
                className: 'filter-list',
                role: 'list',
                'data-testid': 'status-filters',
                children: [...e.entries()].map(([d, S]) =>
                  o.jsx(
                    'div',
                    {
                      className: 'filter-entry',
                      role: 'listitem',
                      children: o.jsxs('label', {
                        children: [
                          o.jsx('input', {
                            type: 'checkbox',
                            checked: S,
                            onChange: () => {
                              const x = new Map(e);
                              x.set(d, !x.get(d)), s(x);
                            },
                          }),
                          o.jsx('div', { children: d }),
                        ],
                      }),
                    },
                    d
                  )
                ),
              }),
              o.jsx('div', {
                className: 'filter-list',
                role: 'list',
                'data-testid': 'project-filters',
                children: [...r.entries()].map(([d, S]) =>
                  o.jsx(
                    'div',
                    {
                      className: 'filter-entry',
                      role: 'listitem',
                      children: o.jsxs('label', {
                        children: [
                          o.jsx('input', {
                            type: 'checkbox',
                            checked: S,
                            onChange: () => {
                              var C;
                              const x = new Map(r);
                              x.set(d, !x.get(d)), c(x);
                              const B =
                                (C = a == null ? void 0 : a.config) == null ? void 0 : C.configFile;
                              B &&
                                vt.setObject(
                                  B + ':projects',
                                  [...x.entries()].filter(([j, W]) => W).map(([j]) => j)
                                );
                            },
                          }),
                          o.jsx('div', { children: d || 'untitled' }),
                        ],
                      }),
                    },
                    d
                  )
                ),
              }),
            ],
          }),
      ],
    });
  },
  ue = ({ tag: i, style: t, onClick: e }) =>
    o.jsx('span', {
      className: at('tag', `tag-color-${he(i)}`),
      onClick: e,
      style: { margin: '6px 0 0 6px', ...t },
      title: `Click to filter by tag: ${i}`,
      children: i,
    });
function he(i) {
  let t = 0;
  for (let e = 0; e < i.length; e++) t = i.charCodeAt(e) + ((t << 8) - t);
  return Math.abs(t % 6);
}
const fe = Wt,
  pe = ({
    filterText: i,
    testModel: t,
    testServerConnection: e,
    testTree: s,
    runTests: r,
    runningState: c,
    watchAll: a,
    watchedTreeIds: g,
    setWatchedTreeIds: l,
    isLoading: _,
    onItemSelected: n,
    requestedCollapseAllCount: h,
    requestedExpandAllCount: v,
    setFilterText: d,
    onRevealSource: S,
  }) => {
    const [x, B] = u.useState({ expandedItems: new Map() }),
      [C, j] = u.useState(),
      [W, F] = u.useState(h),
      [$, N] = u.useState(v);
    u.useEffect(() => {
      if (W !== h) {
        x.expandedItems.clear();
        for (const b of s.flatTreeItems()) x.expandedItems.set(b.id, !1);
        F(h), j(void 0), B({ ...x });
        return;
      }
      if ($ !== v) {
        x.expandedItems.clear();
        for (const b of s.flatTreeItems()) x.expandedItems.set(b.id, !0);
        N(v), j(void 0), B({ ...x });
        return;
      }
      if (!c || c.itemSelectedByUser) return;
      let f;
      const E = (b) => {
        var L;
        b.children.forEach(E),
          !f &&
            b.status === 'failed' &&
            ((b.kind === 'test' && c.testIds.has(b.test.id)) ||
              (b.kind === 'case' && c.testIds.has((L = b.tests[0]) == null ? void 0 : L.id))) &&
            (f = b);
      };
      E(s.rootItem), f && j(f.id);
    }, [c, j, s, W, F, h, $, N, v, x, B]);
    const R = u.useMemo(() => {
      if (C) return s.treeItemById(C);
    }, [C, s]);
    u.useEffect(() => {
      if (!t) return;
      const f = ge(R, t);
      let E;
      (R == null ? void 0 : R.kind) === 'test'
        ? (E = R.test)
        : (R == null ? void 0 : R.kind) === 'case' && R.tests.length === 1 && (E = R.tests[0]),
        n({ treeItem: R, testCase: E, testFile: f });
    }, [t, R, n]),
      u.useEffect(() => {
        if (!_)
          if (a) e == null || e.watchNoReply({ fileNames: s.fileNames() });
          else {
            const f = new Set();
            for (const E of g.value) {
              const b = s.treeItemById(E),
                L = b == null ? void 0 : b.location.file;
              L && f.add(L);
            }
            e == null || e.watchNoReply({ fileNames: [...f] });
          }
      }, [_, s, a, g, e]);
    const J = (f) => {
        j(f.id), r('bounce-if-busy', s.collectTestIds(f));
      },
      H = (f, E) => {
        if ((f.preventDefault(), f.stopPropagation(), f.metaKey || f.ctrlKey)) {
          const b = i.split(' ');
          b.includes(E)
            ? d(
                b
                  .filter((L) => L !== E)
                  .join(' ')
                  .trim()
              )
            : d((i + ' ' + E).trim());
        } else
          d(
            (
              i
                .split(' ')
                .filter((b) => !b.startsWith('@'))
                .join(' ') +
              ' ' +
              E
            ).trim()
          );
      };
    return o.jsx(fe, {
      name: 'tests',
      treeState: x,
      setTreeState: B,
      rootItem: s.rootItem,
      dataTestId: 'test-tree',
      render: (f) => {
        const E = f.id.replace(/[^\w\d-_]/g, '-'),
          b = E + '-label',
          L = E + '-time';
        return o.jsxs('div', {
          className: 'hbox ui-mode-tree-item',
          'aria-labelledby': `${b} ${L}`,
          children: [
            o.jsxs('div', {
              id: b,
              className: 'ui-mode-tree-item-title',
              children: [
                o.jsx('span', { children: f.title }),
                f.kind === 'case'
                  ? f.tags.map((q) => o.jsx(ue, { tag: q.slice(1), onClick: (Z) => H(Z, q) }, q))
                  : null,
              ],
            }),
            !!f.duration &&
              f.status !== 'skipped' &&
              o.jsx('div', {
                id: L,
                className: 'ui-mode-tree-item-time',
                children: zt(f.duration),
              }),
            o.jsxs(Y, {
              noMinHeight: !0,
              noShadow: !0,
              children: [
                o.jsx(D, {
                  icon: 'play',
                  title: 'Run',
                  onClick: () => J(f),
                  disabled: !!c && !c.completed,
                }),
                o.jsx(D, {
                  icon: 'go-to-file',
                  title: 'Show source',
                  onClick: S,
                  style:
                    f.kind === 'group' && f.subKind === 'folder' ? { visibility: 'hidden' } : {},
                }),
                !a &&
                  o.jsx(D, {
                    icon: 'eye',
                    title: 'Watch',
                    onClick: () => {
                      g.value.has(f.id) ? g.value.delete(f.id) : g.value.add(f.id), l({ ...g });
                    },
                    toggled: g.value.has(f.id),
                  }),
              ],
            }),
          ],
        });
      },
      icon: (f) => At(f.status),
      title: (f) => f.title,
      selectedItem: R,
      onAccepted: J,
      onSelected: (f) => {
        c && (c.itemSelectedByUser = !0), j(f.id);
      },
      isError: (f) => (f.kind === 'group' ? f.hasLoadErrors : !1),
      autoExpandDepth: i ? 5 : 1,
      noItemsMessage: _ ? 'Loading…' : 'No tests',
    });
  };
function ge(i, t) {
  if (!(!i || !t))
    return {
      file: i.location.file,
      line: i.location.line,
      column: i.location.column,
      source: {
        errors: t.loadErrors
          .filter((e) => {
            var s;
            return ((s = e.location) == null ? void 0 : s.file) === i.location.file;
          })
          .map((e) => ({ line: e.location.line, message: e.message })),
        content: void 0,
      },
    };
}
function me(i) {
  return `.playwright-artifacts-${i}`;
}
const _e = ({ item: i, rootDir: t, onOpenExternally: e, revealSource: s, pathSeparator: r }) => {
    var h, v;
    const [c, a] = u.useState(),
      [g, l] = u.useState(0),
      _ = u.useRef(null),
      { outputDir: n } = u.useMemo(
        () => ({ outputDir: i.testCase ? we(i.testCase) : void 0 }),
        [i]
      );
    return (
      u.useEffect(() => {
        var B, C;
        _.current && clearTimeout(_.current);
        const d = (B = i.testCase) == null ? void 0 : B.results[0];
        if (!d) {
          a(void 0);
          return;
        }
        const S = d && d.duration >= 0 && d.attachments.find((j) => j.name === 'trace');
        if (S && S.path) {
          mt(S.path).then((j) => a({ model: j, isLive: !1 }));
          return;
        }
        if (!n) {
          a(void 0);
          return;
        }
        const x = [
          n,
          me(d.workerIndex),
          'traces',
          `${(C = i.testCase) == null ? void 0 : C.id}.json`,
        ].join(r);
        return (
          (_.current = setTimeout(async () => {
            try {
              const j = await mt(x);
              a({ model: j, isLive: !0 });
            } catch {
              a(void 0);
            } finally {
              l(g + 1);
            }
          }, 500)),
          () => {
            _.current && clearTimeout(_.current);
          }
        );
      }, [n, i, a, g, l, r]),
      o.jsx(
        Vt,
        {
          model: c == null ? void 0 : c.model,
          showSourcesFirst: !0,
          rootDir: t,
          fallbackLocation: i.testFile,
          isLive: c == null ? void 0 : c.isLive,
          status: (h = i.treeItem) == null ? void 0 : h.status,
          annotations: ((v = i.testCase) == null ? void 0 : v.annotations) || [],
          onOpenExternally: e,
          revealSource: s,
        },
        'workbench'
      )
    );
  },
  we = (i) => {
    var t;
    for (let e = i.parent; e; e = e.parent)
      if (e.project()) return (t = e.project()) == null ? void 0 : t.outputDir;
  };
async function mt(i) {
  const t = new URLSearchParams();
  t.set('trace', i), t.set('limit', '1');
  const s = await (await fetch(`contexts?${t.toString()}`)).json();
  return new Kt(s);
}
let _t = { cols: 80 };
const z = { pending: [], clear: () => {}, write: (i) => z.pending.push(i), resize: () => {} },
  O = new URLSearchParams(window.location.search),
  ve = new URL(O.get('server') ?? '../', window.location.href),
  lt = new URL(O.get('ws'), ve);
lt.protocol = lt.protocol === 'https:' ? 'wss:' : 'ws:';
const I = {
  args: O.getAll('arg'),
  grep: O.get('grep') || void 0,
  grepInvert: O.get('grepInvert') || void 0,
  projects: O.getAll('project'),
  workers: O.get('workers') || void 0,
  headed: O.has('headed'),
  updateSnapshots: O.get('updateSnapshots') || void 0,
  reporters: O.has('reporter') ? O.getAll('reporter') : void 0,
  pathSeparator: O.get('pathSeparator') || '/',
};
I.updateSnapshots &&
  !['all', 'none', 'missing'].includes(I.updateSnapshots) &&
  (I.updateSnapshots = void 0);
const wt = navigator.platform === 'MacIntel',
  Se = ({}) => {
    var gt;
    const [i, t] = u.useState(''),
      [e, s] = u.useState(!1),
      [r, c] = u.useState(!1),
      [a, g] = u.useState(
        new Map([
          ['passed', !1],
          ['failed', !1],
          ['skipped', !1],
        ])
      ),
      [l, _] = u.useState(new Map()),
      [n, h] = u.useState(),
      [v, d] = u.useState(),
      [S, x] = u.useState({}),
      [B, C] = u.useState(new Set()),
      [j, W] = u.useState(!1),
      [F, $] = u.useState(),
      N = F && !F.completed,
      [R, J] = $t('watch-all', !1),
      [H, f] = u.useState({ value: new Set() }),
      E = u.useRef(Promise.resolve()),
      b = u.useRef(new Set()),
      [L, q] = u.useState(0),
      [Z, xt] = u.useState(0),
      [bt, Tt] = u.useState(!1),
      [ct, dt] = u.useState(!0),
      [w, kt] = u.useState(),
      [G, jt] = u.useState(),
      [tt, Et] = u.useState(!1),
      [xe, be] = u.useState(!1),
      [yt, ut] = u.useState(!1),
      It = u.useCallback(() => ut(!0), [ut]),
      Rt = !1,
      [ht, Te] = u.useState(!1),
      [ft, ke] = u.useState(!1),
      [pt, je] = u.useState(!1),
      Bt = u.useRef(null),
      et = u.useCallback(() => {
        kt((p) => (p == null || p.close(), new Ht(new qt(lt))));
      }, []);
    u.useEffect(() => {
      var p;
      (p = Bt.current) == null || p.focus(), W(!0), et();
    }, [et]),
      u.useEffect(() => {
        if (!w) return;
        const p = [
          w.onStdio((m) => {
            if (m.buffer) {
              const T = atob(m.buffer);
              z.write(T);
            } else z.write(m.text);
            m.type === 'stderr' && c(!0);
          }),
          w.onClose(() => Tt(!0)),
        ];
        return (
          (z.resize = (m, T) => {
            (_t = { cols: m, rows: T }), w.resizeTerminalNoReply({ cols: m, rows: T });
          }),
          () => {
            for (const m of p) m.dispose();
          }
        );
      }, [w]),
      u.useEffect(() => {
        if (!w) return;
        let p;
        const m = new ne({
          onUpdate: (T) => {
            clearTimeout(p),
              (p = void 0),
              T
                ? h(m.asModel())
                : p ||
                  (p = setTimeout(() => {
                    h(m.asModel());
                  }, 250));
          },
          onError: (T) => {
            z.write(
              (T.stack || T.value || '') +
                `
`
            ),
              c(!0);
          },
          pathSeparator: I.pathSeparator,
        });
        return (
          jt(m),
          h(void 0),
          W(!0),
          f({ value: new Set() }),
          (async () => {
            try {
              await w.initialize({ interceptStdio: !0, watchTestDirs: !0 });
              const { status: T, report: y } = await w.runGlobalSetup({});
              if ((m.processGlobalReport(y), T !== 'passed')) return;
              const P = await w.listTests({
                projects: I.projects,
                locations: I.args,
                grep: I.grep,
                grepInvert: I.grepInvert,
              });
              m.processListReport(P.report),
                w.onReport((M) => {
                  m.processTestReportEvent(M);
                });
              const { hasBrowsers: U } = await w.checkBrowsers({});
              dt(U);
            } finally {
              W(!1);
            }
          })(),
          () => {
            clearTimeout(p);
          }
        );
      }, [w]),
      u.useEffect(() => {
        if (!n) return;
        const { config: p, rootSuite: m } = n,
          T = p.configFile ? vt.getObject(p.configFile + ':projects', void 0) : void 0,
          y = new Map(l);
        for (const P of y.keys()) m.suites.find((U) => U.title === P) || y.delete(P);
        for (const P of m.suites)
          y.has(P.title) || y.set(P.title, !!(T != null && T.includes(P.title)));
        !T && y.size && ![...y.values()].includes(!0) && y.set(y.entries().next().value[0], !0),
          (l.size !== y.size || [...l].some(([P, U]) => y.get(P) !== U)) && _(y);
      }, [l, n]),
      u.useEffect(() => {
        N && n != null && n.progress ? d(n.progress) : n || d(void 0);
      }, [n, N]);
    const { testTree: Ct } = u.useMemo(() => {
        if (!n) return { testTree: new nt('', new Q('', 'root'), [], l, I.pathSeparator) };
        const p = new nt('', n.rootSuite, n.loadErrors, l, I.pathSeparator);
        return (
          p.filterTree(i, a, N ? (F == null ? void 0 : F.testIds) : void 0),
          p.sortAndPropagateStatus(),
          p.shortenRoot(),
          p.flattenForSingleProject(),
          C(p.testIds()),
          { testTree: p }
        );
      }, [i, n, a, l, C, F, N]),
      V = u.useCallback(
        (p, m) => {
          !w ||
            !n ||
            (p === 'bounce-if-busy' && N) ||
            ((b.current = new Set([...b.current, ...m])),
            (E.current = E.current.then(async () => {
              var P, U, M;
              const T = b.current;
              if (((b.current = new Set()), !T.size)) return;
              {
                for (const k of ((P = n.rootSuite) == null ? void 0 : P.allTests()) || [])
                  if (T.has(k.id)) {
                    k.results = [];
                    const A = k._createTestResult('pending');
                    A[X] = 'scheduled';
                  }
                h({ ...n });
              }
              const y = '  [' + new Date().toLocaleTimeString() + ']';
              z.write('\x1B[2m—'.repeat(Math.max(0, _t.cols - y.length)) + y + '\x1B[22m'),
                d({ total: 0, passed: 0, failed: 0, skipped: 0 }),
                $({ testIds: T }),
                await w.runTests({
                  locations: I.args,
                  grep: I.grep,
                  grepInvert: I.grepInvert,
                  testIds: [...T],
                  projects: [...l].filter(([k, A]) => A).map(([k]) => k),
                  ...(ht ? { workers: '1' } : {}),
                  ...(ft ? { headed: !0 } : {}),
                  ...(pt ? { updateSnapshots: 'all' } : {}),
                  reporters: I.reporters,
                  trace: 'on',
                });
              for (const k of ((U = n.rootSuite) == null ? void 0 : U.allTests()) || [])
                ((M = k.results[0]) == null ? void 0 : M.duration) === -1 && (k.results = []);
              h({ ...n }), $((k) => (k ? { ...k, completed: !0 } : void 0));
            })));
        },
        [l, N, n, w, ht, ft, pt]
      );
    u.useEffect(() => {
      if (!w || !G) return;
      const p = w.onTestFilesChanged(async (m) => {
        if (
          ((E.current = E.current.then(async () => {
            W(!0);
            try {
              const M = await w.listTests({
                projects: I.projects,
                locations: I.args,
                grep: I.grep,
                grepInvert: I.grepInvert,
              });
              G.processListReport(M.report);
            } catch (M) {
              console.log(M);
            } finally {
              W(!1);
            }
          })),
          await E.current,
          m.testFiles.length === 0)
        )
          return;
        const T = G.asModel(),
          y = new nt('', T.rootSuite, T.loadErrors, l, I.pathSeparator),
          P = [],
          U = new Set(m.testFiles);
        if (R) {
          const M = (k) => {
            const A = k.location.file;
            A && U.has(A) && P.push(...y.collectTestIds(k)),
              k.kind === 'group' && k.subKind === 'folder' && k.children.forEach(M);
          };
          M(y.rootItem);
        } else
          for (const M of H.value) {
            const k = y.treeItemById(M),
              A = k == null ? void 0 : k.location.file;
            A && U.has(A) && P.push(...y.collectTestIds(k));
          }
        V('queue-if-busy', new Set(P));
      });
      return () => p.dispose();
    }, [V, w, R, H, G, l]),
      u.useEffect(() => {
        if (!w) return;
        const p = (m) => {
          m.code === 'Backquote' && m.ctrlKey
            ? (m.preventDefault(), s(!e))
            : m.code === 'F5' && m.shiftKey
              ? (m.preventDefault(), w == null || w.stopTestsNoReply({}))
              : m.code === 'F5' && (m.preventDefault(), V('bounce-if-busy', B));
        };
        return (
          addEventListener('keydown', p),
          () => {
            removeEventListener('keydown', p);
          }
        );
      }, [V, et, w, B, e]);
    const it = u.useRef(null),
      Pt = u.useCallback((p) => {
        var m;
        p.preventDefault(), p.stopPropagation(), (m = it.current) == null || m.showModal();
      }, []),
      rt = u.useCallback((p) => {
        var m;
        p.preventDefault(), p.stopPropagation(), (m = it.current) == null || m.close();
      }, []),
      Nt = u.useCallback(
        (p) => {
          rt(p),
            s(!0),
            w == null ||
              w.installBrowsers({}).then(async () => {
                s(!1);
                const { hasBrowsers: m } = await (w == null ? void 0 : w.checkBrowsers({}));
                dt(m);
              });
        },
        [rt, w]
      );
    return o.jsx(Yt, {
      children: o.jsxs('div', {
        className: 'vbox ui-mode',
        children: [
          !ct &&
            o.jsxs('dialog', {
              ref: it,
              children: [
                o.jsxs('div', {
                  className: 'title',
                  children: [
                    o.jsx('span', { className: 'codicon codicon-lightbulb' }),
                    'Install browsers',
                  ],
                }),
                o.jsxs('div', {
                  className: 'body',
                  children: [
                    'Playwright did not find installed browsers.',
                    o.jsx('br', {}),
                    'Would you like to run `playwright install`?',
                    o.jsx('br', {}),
                    o.jsx('button', { className: 'button', onClick: Nt, children: 'Install' }),
                    o.jsx('button', {
                      className: 'button secondary',
                      onClick: rt,
                      children: 'Dismiss',
                    }),
                  ],
                }),
              ],
            }),
          bt &&
            o.jsxs('div', {
              className: 'disconnected',
              children: [
                o.jsx('div', { className: 'title', children: 'UI Mode disconnected' }),
                o.jsxs('div', {
                  children: [
                    o.jsx('a', {
                      href: '#',
                      onClick: () => (window.location.href = '/'),
                      children: 'Reload the page',
                    }),
                    ' to reconnect',
                  ],
                }),
              ],
            }),
          o.jsx(Qt, {
            sidebarSize: 250,
            minSidebarSize: 150,
            orientation: 'horizontal',
            sidebarIsFirst: !0,
            settingName: 'testListSidebar',
            main: o.jsxs('div', {
              className: 'vbox',
              children: [
                o.jsxs('div', {
                  className: at('vbox', !e && 'hidden'),
                  children: [
                    o.jsxs(Y, {
                      children: [
                        o.jsx('div', {
                          className: 'section-title',
                          style: { flex: 'none' },
                          children: 'Output',
                        }),
                        o.jsx(D, {
                          icon: 'circle-slash',
                          title: 'Clear output',
                          onClick: () => {
                            z.clear(), c(!1);
                          },
                        }),
                        o.jsx('div', { className: 'spacer' }),
                        o.jsx(D, { icon: 'close', title: 'Close', onClick: () => s(!1) }),
                      ],
                    }),
                    o.jsx(ae, { source: z }),
                  ],
                }),
                o.jsx('div', {
                  className: at('vbox', e && 'hidden'),
                  children: o.jsx(_e, {
                    pathSeparator: I.pathSeparator,
                    item: S,
                    rootDir: (gt = n == null ? void 0 : n.config) == null ? void 0 : gt.rootDir,
                    revealSource: yt,
                    onOpenExternally: (p) =>
                      w == null
                        ? void 0
                        : w.openNoReply({
                            location: { file: p.file, line: p.line, column: p.column },
                          }),
                  }),
                }),
              ],
            }),
            sidebar: o.jsxs('div', {
              className: 'vbox ui-mode-sidebar',
              children: [
                o.jsxs(Y, {
                  noShadow: !0,
                  noMinHeight: !0,
                  children: [
                    o.jsx('img', { src: 'playwright-logo.svg', alt: 'Playwright logo' }),
                    o.jsx('div', { className: 'section-title', children: 'Playwright' }),
                    o.jsx(D, {
                      icon: 'refresh',
                      title: 'Reload',
                      onClick: () => et(),
                      disabled: N || j,
                    }),
                    o.jsxs('div', {
                      style: { position: 'relative' },
                      children: [
                        o.jsx(D, {
                          icon: 'terminal',
                          title: 'Toggle output — ' + (wt ? '⌃`' : 'Ctrl + `'),
                          toggled: e,
                          onClick: () => {
                            s(!e);
                          },
                        }),
                        r &&
                          o.jsx('div', {
                            title: 'Output contains error',
                            style: {
                              position: 'absolute',
                              top: 2,
                              right: 2,
                              width: 7,
                              height: 7,
                              borderRadius: '50%',
                              backgroundColor: 'var(--vscode-notificationsErrorIcon-foreground)',
                            },
                          }),
                      ],
                    }),
                    !ct &&
                      o.jsx(D, {
                        icon: 'lightbulb-autofix',
                        style: { color: 'var(--vscode-list-warningForeground)' },
                        title: 'Playwright browsers are missing',
                        onClick: Pt,
                      }),
                  ],
                }),
                o.jsx(de, {
                  filterText: i,
                  setFilterText: t,
                  statusFilters: a,
                  setStatusFilters: g,
                  projectFilters: l,
                  setProjectFilters: _,
                  testModel: n,
                  runTests: () => V('bounce-if-busy', B),
                }),
                o.jsxs(Y, {
                  noMinHeight: !0,
                  children: [
                    !N && !v && o.jsx('div', { className: 'section-title', children: 'Tests' }),
                    !N &&
                      v &&
                      o.jsx('div', {
                        'data-testid': 'status-line',
                        className: 'status-line',
                        children: o.jsxs('div', {
                          children: [
                            v.passed,
                            '/',
                            v.total,
                            ' passed (',
                            ((v.passed / v.total) * 100) | 0,
                            '%)',
                          ],
                        }),
                      }),
                    N &&
                      v &&
                      o.jsx('div', {
                        'data-testid': 'status-line',
                        className: 'status-line',
                        children: o.jsxs('div', {
                          children: [
                            'Running ',
                            v.passed,
                            '/',
                            F.testIds.size,
                            ' passed (',
                            ((v.passed / F.testIds.size) * 100) | 0,
                            '%)',
                          ],
                        }),
                      }),
                    o.jsx(D, {
                      icon: 'play',
                      title: 'Run all — F5',
                      onClick: () => V('bounce-if-busy', B),
                      disabled: N || j,
                    }),
                    o.jsx(D, {
                      icon: 'debug-stop',
                      title: 'Stop — ' + (wt ? '⇧F5' : 'Shift + F5'),
                      onClick: () => (w == null ? void 0 : w.stopTests({})),
                      disabled: !N || j,
                    }),
                    o.jsx(D, {
                      icon: 'eye',
                      title: 'Watch all',
                      toggled: R,
                      onClick: () => {
                        f({ value: new Set() }), J(!R);
                      },
                    }),
                    o.jsx(D, {
                      icon: 'collapse-all',
                      title: 'Collapse all',
                      onClick: () => {
                        q(L + 1);
                      },
                    }),
                    o.jsx(D, {
                      icon: 'expand-all',
                      title: 'Expand all',
                      onClick: () => {
                        xt(Z + 1);
                      },
                    }),
                  ],
                }),
                o.jsx(pe, {
                  filterText: i,
                  testModel: n,
                  testTree: Ct,
                  testServerConnection: w,
                  runningState: F,
                  runTests: V,
                  onItemSelected: x,
                  watchAll: R,
                  watchedTreeIds: H,
                  setWatchedTreeIds: f,
                  isLoading: j,
                  requestedCollapseAllCount: L,
                  requestedExpandAllCount: Z,
                  setFilterText: t,
                  onRevealSource: It,
                }),
                Rt,
                o.jsxs(Y, {
                  noShadow: !0,
                  noMinHeight: !0,
                  className: 'settings-toolbar',
                  onClick: () => Et(!tt),
                  children: [
                    o.jsx('span', {
                      className: `codicon codicon-${tt ? 'chevron-down' : 'chevron-right'}`,
                      style: { marginLeft: 5 },
                      title: tt ? 'Hide Settings' : 'Show Settings',
                    }),
                    o.jsx('div', { className: 'section-title', children: 'Settings' }),
                  ],
                }),
                tt && o.jsx(Xt, {}),
              ],
            }),
          }),
        ],
      }),
    });
  };
(async () => {
  if ((Jt(), window.location.protocol !== 'file:')) {
    if (
      (window.location.href.includes('isUnderTest=true') &&
        (await new Promise((i) => setTimeout(i, 1e3))),
      !navigator.serviceWorker)
    )
      throw new Error(`Service workers are not supported.
Make sure to serve the website (${window.location}) via HTTPS or localhost.`);
    navigator.serviceWorker.register('sw.bundle.js'),
      navigator.serviceWorker.controller ||
        (await new Promise((i) => {
          navigator.serviceWorker.oncontrollerchange = () => i();
        })),
      setInterval(function () {
        fetch('ping');
      }, 1e4);
  }
  Zt.createRoot(document.querySelector('#root')).render(o.jsx(Se, {}));
})();
