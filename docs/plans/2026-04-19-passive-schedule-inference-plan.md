# Passive Schedule Inference Plan

Date: 2026-04-19

## Fixed Product Decisions

- HealthKit sleep access is optional, not required.
- Apple Watch support is a later quality tier, not part of the first release.
- Telemetry should remain local and agent-only for now, persisted in the local SQLite-backed LifeOps storage.
- Meal-linked reminders should bias slightly toward recall over precision, which means occasional false positives are acceptable if bounded by cooldowns and sleep suppression.

## Goal

Build a passive schedule inference system for LifeOps that estimates, per user and per day:

- whether the user slept
- when the user likely fell asleep
- when the user likely woke up
- how long they likely slept
- when the user likely ate
- whether current reminder timing should adapt because the user just woke up, is likely asleep, is in a meal window, or is in an abnormal day state

This is not one model. It is three systems:

1. sleep and wake interval inference
2. meal event inference
3. reminder policy that consumes uncertain predictions and decides whether to notify, delay, suppress, or escalate

## Why This Exists

The target users are explicitly not regular. Fixed schedules, static reminder windows, and manual onboarding assumptions are the wrong shape for this product. LifeOps needs to infer routine from behavior, then act on confidence rather than pretend certainty.

## Current Repo Baseline

LifeOps already has several pieces of the stack:

- Activity profile fields already include wake and sleep summaries in [activity-profile/types.ts](/Users/shawwalters/eliza-workspace/eliza/eliza/apps/app-lifeops/src/activity-profile/types.ts:72).
- Current profile analysis already derives heuristic `typicalWakeHour`, `typicalSleepHour`, `isCurrentlySleeping`, and related fields in [activity-profile/analyzer.ts](/Users/shawwalters/eliza-workspace/eliza/eliza/apps/app-lifeops/src/activity-profile/analyzer.ts:604).
- Reminder windows already adapt from inferred wake and sleep rhythm in [lifeops/defaults.ts](/Users/shawwalters/eliza-workspace/eliza/eliza/apps/app-lifeops/src/lifeops/defaults.ts:117).
- The app already captures page, app lifecycle, desktop power, and mobile health signals in [useLifeOpsActivitySignals.ts](/Users/shawwalters/eliza-workspace/eliza/eliza/apps/app-lifeops/src/hooks/useLifeOpsActivitySignals.ts:102).
- The mobile signals plugin already exposes HealthKit sleep and biometrics in [mobile-signals definitions](/Users/shawwalters/eliza-workspace/eliza/eliza/packages/native-plugins/mobile-signals/src/definitions.ts:16).
- The macOS native activity tracker already records foreground app focus transitions in [activity-collector.swift](/Users/shawwalters/eliza-workspace/eliza/eliza/packages/native-plugins/activity-tracker/native/macos/activity-collector.swift:79).
- Browser focus time is captured by the canonical LifeOps browser companion in [page-extract.ts](/Users/shawwalters/eliza-workspace/eliza/eliza/apps/app-lifeops/extensions/lifeops-browser/src/page-extract.ts:1) and persisted through the browser activity store.
- Screen-time storage exists in [service-mixin-screentime.ts](/Users/shawwalters/eliza-workspace/eliza/eliza/apps/app-lifeops/src/lifeops/service-mixin-screentime.ts:37).
- Proactive GM/GN and pre-activity nudges already exist in [proactive-planner.ts](/Users/shawwalters/eliza-workspace/eliza/eliza/apps/app-lifeops/src/activity-profile/proactive-planner.ts:81).

What is missing:

- a canonical telemetry layer across iPhone, Mac, and browser
- a real inference pipeline with confidence scores
- any meal inference implementation
- a persisted schedule posterior or per-day inferred timeline
- production wiring into the existing screen-time session store
- inspection tooling that shows why the model believed sleep or meals happened

## Product Scope

### In scope

- passive schedule estimation on iPhone and Mac
- adaptive reminder timing based on posterior state
- application tracking and screen-time tracking where public APIs or local native capture allow it
- optional enrichment from Apple Watch, HealthKit, and later CGM
- local-first inference with explicit confidence and traceability

### Out of scope for v1

- pretending meal inference is clinically reliable without personalization
- unrestricted raw Screen Time export from iPhone
- sleep stage modeling beyond what HealthKit already provides
- server-dependent training loops that require uploading raw sensitive event streams
- hard enforcement behavior based on low-confidence sleep or meal states

## Constraints

### Platform constraints

- Apple Screen Time access is entitlement-gated. `FamilyControls` requires capability setup and App Store approval before submission.
- The public `DeviceActivity` surface is privacy-preserving and report-oriented, not a general raw event feed.
- `DeviceActivityReport` runs in a sandboxed extension and cannot make network requests or move sensitive content outside the extension address space.
- The current repo already proves `FamilyControls` individual authorization is viable on iPhone, but also shows timed blocking is blocked on adding a `DeviceActivity` extension in [AppBlockerPlugin.swift](/Users/shawwalters/eliza-workspace/eliza/eliza/packages/native-plugins/appblocker/ios/Sources/AppBlockerPlugin/AppBlockerPlugin.swift:95).
- On Mac, the repo currently relies on native local tracking, not Apple Screen Time APIs.

### Product constraints

- Users have irregular schedules and may skip sleep, nap, graze, or eat at night.
- The system must handle “no clear answer” as a first-class output.
- Reminders must not fire during probable sleep unless explicitly configured otherwise.
- The UI cannot compute the schedule; inference belongs in backend or domain use cases only.

### Privacy constraints

- Sleep and meal inference are health-adjacent and sensitive.
- Raw app usage, location, and health data should stay local by default.
- For the initial implementation, telemetry should remain local and agent-only and persist in the local SQLite-backed LifeOps store.
- If sync is added later, it should prefer aggregates, posterior states, and compact evidence windows over raw event histories.

## What Information The Predictor Actually Needs

### Base tier: iPhone + Mac only

- iPhone device activity summaries:
  - segment total activity duration
  - longest activity interval
  - first pickup
  - pickups without app activity
  - app and web-domain duration where available through `DeviceActivity`
- iPhone device state:
  - foreground or background
  - charging transitions
  - battery state
  - motion activity changes
  - significant location changes
- Mac state:
  - foreground application changes
  - idle time
  - display sleep and wake
  - system sleep and wake
  - session active and resign active
- Browser:
  - focused domain sessions
- Time features:
  - local time of day
  - day of week
  - time since last active event
  - time since last charging change
  - time at home versus elsewhere if location is enabled

### Optional high-value tier

- HealthKit sleep analysis
- HealthKit biometrics already exposed by the mobile plugin
- HealthKit medication dose events
- Apple Watch sleep and wrist temperature context

### Optional highest-value tier

- Apple Watch inertial sensing for meal detection
- CGM-assisted meal labeling or retrospective correction

## Recommended Architecture

### 1. Canonical telemetry ingestion

Create one canonical life telemetry pipeline for passive signals. Do not keep screen time, browser time, activity signals, and inferred schedule as disconnected stores.

Recommended streams:

- `device_activity_summary`
- `desktop_focus_event`
- `desktop_idle_snapshot`
- `desktop_power_event`
- `browser_focus_window`
- `mobile_health_snapshot`
- `mobile_motion_snapshot`
- `mobile_location_snapshot`
- `charging_event`

Recommendation:

- keep raw capture local and append-only
- normalize all timestamps to UTC plus stored user timezone
- derive features in a separate use case layer
- persist derived daily summaries and posterior schedule states separately from raw telemetry

### 2. Feature extraction layer

Compute multi-scale features over:

- last 5 minutes
- last 15 minutes
- last 60 minutes
- last 4 hours
- last 24 hours
- trailing 7-day rhythm baseline

Feature groups:

- recency of interaction
- intensity of interaction
- fragmentation of interaction
- longest quiet window
- charging while inactive
- home dwell
- recent motion state
- foreground app category mix
- browser domain category mix
- deviation from personal baseline

### 3. Inference layer

Use separate predictors:

- sleep interval detector
- wake transition detector
- meal event detector

Required outputs:

- `sleepProbability`
- `wakeTransitionProbability`
- `mealProbability`
- `confidence`
- `evidenceSummary`
- `predictedStartAt`
- `predictedEndAt`
- `isNap`
- `dayState`: normal, sleep-deprived, fragmented, night-shift-like, unclear

### 4. Daily schedule synthesizer

Generate a daily latent schedule object that merges:

- yesterday’s posterior
- current-day observations
- rolling personal baseline
- explicit routine definitions if the user has them

This object becomes the only source of truth for reminder timing.

### 5. Reminder policy

The reminder layer should consume posterior state and confidence, not raw telemetry.

Policy rules:

- suppress during probable sleep
- delay if wake transition is underway but unstable
- trigger “after wake” reminders only after sustained post-wake activity
- trigger meal-linked reminders only when meal probability crosses threshold and cooldown rules permit
- degrade gracefully to static windows when confidence is low

## Predictor Alternatives

### Option A: rules-first system

Use deterministic heuristics for sleep and weak meal heuristics.

Pros:

- fastest to ship
- fully inspectable
- good bootstrap for labels

Cons:

- weak on naps, fragmented sleepers, shift workers, and irregular eaters
- meal inference will be mediocre

### Option B: duration-aware probabilistic state model

Use hidden states such as awake, winding-down, asleep, meal, post-meal, and unknown, with duration constraints.

Pros:

- matches the real structure of the problem
- handles uncertainty better than raw thresholds
- good fit for online inference

Cons:

- more implementation work
- requires careful calibration

### Option C: personalized discriminative model on time bins

Use 5-minute bins with gradient-boosted trees or a compact temporal model.

Pros:

- strongest pure-software option on phone plus Mac
- personalization materially improves both sleep and meal prediction

Cons:

- needs a label strategy and evaluation pipeline
- harder to debug than rules alone

### Recommended path

Use a hybrid:

1. rules-first bootstrap for sleep and weak meal candidates
2. personalized discriminative model over binned features
3. thin state machine over predictions to produce a stable daily schedule

Do not start with a monolithic end-to-end model.

## Data Flow

1. Device-native collectors capture raw signals.
2. Signals are normalized into canonical telemetry records.
3. Feature extraction jobs compute rolling feature windows.
4. Predictors emit sleep, wake, and meal posteriors.
5. The daily schedule synthesizer materializes the current schedule estimate.
6. Reminder processing reads the schedule estimate and decides whether to notify.
7. Inspection views expose evidence and confidence for each inferred event.

## LifeOps Integration Plan

### Phase 0: instrumentation audit

- inventory all current signal sources
- identify what is persisted versus runtime-only
- wire production ingestion into `recordScreenTimeEvent`
- stop relying on the browser runtime cache as the long-term source of truth

### Phase 1: canonical telemetry and inspection

- add canonical signal ingestion and derived daily summaries
- add a developer or owner-facing schedule inspection view
- expose “why we think you slept” and “why we think you ate”

### Phase 2: sleep first

- ship sleep interval and wake detection
- persist daily posterior sleep intervals
- replace current heuristic-only rhythm derivation with posterior-backed fields
- feed after-wake and before-bed reminder windows from the new schedule object
- make HealthKit an optional high-confidence label and enrichment source rather than a hard dependency

### Phase 3: adaptive reminders

- move proactive GM and GN to schedule-posterior inputs
- add confidence gating, cooldowns, and suppression rules
- measure reminder outcome quality

### Phase 4: meal inference

- start with phone and Mac contextual meal candidates
- add meal-linked reminder triggers with thresholds tuned to favor recall over precision
- require explicit cooldowns, sleep suppression, and low-confidence handling so acceptable false positives do not become spam

### Phase 5: optional watch and CGM tiers

- add Apple Watch path for higher-quality meal detection
- add CGM-assisted retrospective correction for users who have it

## Evaluation Plan

### Sleep

- bedtime start error
- wake time error
- total sleep duration error
- false “slept” and false “did not sleep” rates
- nap detection precision and recall

### Meals

- event-level AUROC
- precision and recall
- start-time error
- false positives per day

### Reminders

- acted-on rate
- dismissed or snoozed rate
- reminder timing relative to inferred wake and meal events
- annoyance indicators such as repeated suppressions or quick dismissals

## Kimai Assessment

Kimai is relevant as a product reference for:

- reporting UX
- timeline aggregation
- daily and weekly rollups
- exportable activity summaries

Kimai is not a solution for:

- passive life-state inference
- Apple entitlement handling
- local-first sensor fusion
- sleep or meal prediction

Use it as inspiration for analytics surfaces, not as an architectural dependency.

## Main Risks

- meal inference without watch data may not be good enough for aggressive reminder timing
- Screen Time APIs on iPhone are more constrained than raw event thinking suggests
- labels are the hardest problem, not model code
- Mac activity is useful evidence but not a sleep ground truth
- users with shared devices, long idle streaming sessions, or nocturnal browsing will create ambiguous states
- privacy review and App Review risk rises if raw usage data is uploaded unnecessarily

## Unknowns That Need Product Decisions

- Do you want naps to affect the daily schedule immediately, or only overnight sleep?
- What retention policy should local raw telemetry follow inside the SQLite store?
- Do reminder acknowledgements and misses become training labels automatically, or are they only policy feedback at first?

## Recommendation

Implement this as a local-first, confidence-aware digital phenotyping system with sleep as the anchor state, meals as a second predictor, and reminders as a separate policy layer.

The right first implementation is not “predict the whole life schedule perfectly.” It is:

1. unify telemetry
2. ship reliable sleep and wake inference
3. route reminders through posterior schedule state
4. add meal inference only after inspection and calibration tooling exists

## Research References

- Apple `FamilyControls`: https://developer.apple.com/documentation/familycontrols
- Apple `AuthorizationCenter`: https://developer.apple.com/documentation/familycontrols/authorizationcenter
- Apple `DeviceActivity`: https://developer.apple.com/documentation/deviceactivity
- Apple `DeviceActivityReport`: https://developer.apple.com/documentation/deviceactivity/deviceactivityreport
- Apple `DeviceActivityData`: https://developer.apple.com/documentation/deviceactivity/deviceactivitydata
- Apple `ActivitySegment.totalActivityDuration`: https://developer.apple.com/documentation/deviceactivity/deviceactivitydata/activitysegment/totalactivityduration
- Apple `ActivitySegment.longestActivity`: https://developer.apple.com/documentation/deviceactivity/deviceactivitydata/activitysegment/longestactivity
- Apple `ActivitySegment.firstPickup`: https://developer.apple.com/documentation/deviceactivity/deviceactivitydata/activitysegment/firstpickup
- Apple `HKCategoryValueSleepAnalysis`: https://developer.apple.com/documentation/healthkit/hkcategoryvaluesleepanalysis
- Apple `HKQuantityTypeIdentifier.dietaryEnergyConsumed`: https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier
- Apple `HKMedicationDoseEvent.LogStatus`: https://developer.apple.com/documentation/healthkit/hkmedicationdoseevent/logstatus-swift.enum
- Apple `appleSleepingWristTemperature`: https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/applesleepingwristtemperature
- Apple `CMMotionActivityManager`: https://developer.apple.com/documentation/coremotion/cmmotionactivitymanager
- Apple `startMonitoringSignificantLocationChanges()`: https://developer.apple.com/documentation/corelocation/cllocationmanager/startmonitoringsignificantlocationchanges%28%29
- Apple `CGEventSource.secondsSinceLastEventType`: https://developer.apple.com/documentation/coregraphics/cgeventsource/secondssincelasteventtype%28_%3Aeventtype%3A%29
- Apple `NSWorkspace`: https://developer.apple.com/documentation/appkit/nsworkspace
- Kimai: https://github.com/kimai/kimai
- Smartphone touch interaction and sleep-wake cycles: https://www.nature.com/articles/s41746-019-0147-4
- mindLAMP passive sleep estimation: https://www.nature.com/articles/s44184-023-00023-0
- EARS smartphone sleep comparison: https://formative.jmir.org/2025/1/e67455
- Smartphone-only meal inference: https://arxiv.org/abs/2205.14191
- Apple Watch meal detection: https://www.jmir.org/2022/3/e27934/
- Beiwe: https://github.com/onnela-lab/beiwe
- Forest: https://forest.beiwe.org/
- mindLAMP docs: https://docs.lamp.digital/docs/
- AWARE iOS: https://github.com/tetujin/AWAREFramework-iOS
- pyActigraphy: https://github.com/ghammad/pyActigraphy
