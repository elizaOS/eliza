import { actors as packActors } from "@feed/pack-default";
import type { ActorData, PackActor } from "@feed/shared";

function toLegacyActorData(packActor: PackActor): ActorData {
  const displayNameParts = packActor.name.trim().split(/\s+/);
  const realNameParts = (packActor.realName ?? packActor.name)
    .trim()
    .split(/\s+/);

  return {
    id: packActor.id,
    name: packActor.name,
    realName: packActor.realName ?? packActor.name,
    username: packActor.username,
    description: packActor.description,
    profileDescription: packActor.profileDescription,
    domain: [...packActor.domain],
    ignoreTopics: packActor.ignoreTopics
      ? [...packActor.ignoreTopics]
      : undefined,
    engagementThreshold: packActor.engagementThreshold,
    personality: packActor.personality,
    voice: packActor.voice,
    tier: packActor.tier,
    affiliations: [...packActor.affiliations],
    postStyle: packActor.postStyle,
    postExample: [...packActor.postExamples],
    hasPool: packActor.hasPool ?? false,
    pfpDescription: packActor.pfpDescription,
    profileBanner: packActor.profileBanner,
    originalFirstName: packActor.originalFirstName ?? realNameParts[0] ?? "",
    originalLastName:
      packActor.originalLastName ?? realNameParts.slice(1).join(" "),
    originalHandle: packActor.originalHandle ?? packActor.username,
    firstName: packActor.firstName ?? displayNameParts[0] ?? packActor.name,
    lastName: packActor.lastName ?? displayNameParts.slice(1).join(" "),
  };
}

export const actors: ActorData[] = packActors.map(toLegacyActorData);
