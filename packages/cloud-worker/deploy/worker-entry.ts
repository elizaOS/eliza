// spec/cloud/deployment.md, "Story: Serve the deployment from a Worker"
import { cloudWorker, type CloudBindings, type WorkerExecution } from "../src/worker.vibe"

declare const __BUNDLED_CLOUD_PROFILE__: string | undefined

const bundledProfile = typeof __BUNDLED_CLOUD_PROFILE__ === "string" && __BUNDLED_CLOUD_PROFILE__.length > 0
  ? __BUNDLED_CLOUD_PROFILE__
  : undefined

const upstream = cloudWorker()
const cachedBindings = new WeakMap<object, CloudBindings>()

function withBundledProfile(env: CloudBindings): CloudBindings {
  if (bundledProfile === undefined || (typeof env.CLOUD_PROFILE === "string" && env.CLOUD_PROFILE.length > 0)) {
    return env
  }
  const existing = cachedBindings.get(env)
  if (existing !== undefined) return existing
  const merged: CloudBindings = { ...env, CLOUD_PROFILE: bundledProfile }
  cachedBindings.set(env, merged)
  return merged
}

export class RetiredDurableObject {
  fetch(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 410 }))
  }

  alarm(): Promise<void> {
    return Promise.resolve()
  }
}

export {
  RetiredDurableObject as A2ATaskState,
  RetiredDurableObject as AnonymousChatGate,
  RetiredDurableObject as AuthenticationState,
  RetiredDurableObject as DoorDashCheckoutGate,
  RetiredDurableObject as HfEgressState,
  RetiredDurableObject as InferenceRateLimitV2RollbackFloor,
  RetiredDurableObject as OnboardingSessionCoordinator,
  RetiredDurableObject as PersonalDeliveryProjection,
  RetiredDurableObject as PersonalTelegramDelivery,
  RetiredDurableObject as RateLimitState,
  RetiredDurableObject as SharedRuntimeConversation,
  RetiredDurableObject as SpeechRelayCoordinator,
  RetiredDurableObject as TwitterOAuthRefreshCoordinator,
  RetiredDurableObject as VoiceUsageState,
}

export default {
  fetch(request: Request, env: CloudBindings, execution?: WorkerExecution): Promise<Response> {
    return upstream.fetch(request, withBundledProfile(env), execution)
  },
  scheduled(event: { readonly scheduledTime: number }, env: CloudBindings): Promise<void> {
    return upstream.scheduled(event, withBundledProfile(env))
  },
}
