import { characters } from "../../data/characters.ts";
import type { TownAgent } from "../../shared/types";
import { Character } from "./Character.tsx";

export type SelectElement = (element?: { kind: "player"; id: string }) => void;

export const Player = ({
  agent,
  tileDim,
  onClick,
}: {
  agent: TownAgent;
  tileDim: number;
  onClick: SelectElement;
}) => {
  const character = characters.find((c) => c.name === agent.characterId);
  if (!character) {
    return null;
  }

  const now = Date.now();
  const isMoving = agent.status === "moving";
  const speechMessage =
    agent.lastMessage &&
    agent.lastMessageExpiresAt &&
    agent.lastMessageExpiresAt > now
      ? agent.lastMessage
      : undefined;
  const { thoughtText, speechText } = splitThoughtAndSpeech(speechMessage);
  const activeEmote =
    agent.emote && agent.emoteExpiresAt && agent.emoteExpiresAt > now
      ? agent.emote
      : "";
  const renderPosition = agent.renderPosition ?? agent.position;
  const headOffsetPx = tileDim;
  return (
    <Character
      x={renderPosition.x * tileDim + tileDim / 2}
      y={renderPosition.y * tileDim + tileDim / 2}
      orientation={agent.orientation}
      isMoving={isMoving}
      thoughtText={thoughtText}
      speechText={speechText}
      headOffsetPx={headOffsetPx}
      emoji={activeEmote ?? ""}
      isViewer={false}
      textureUrl={character.textureUrl}
      spritesheetData={character.spritesheetData}
      speed={character.speed}
      onClick={() => {
        onClick({ kind: "player", id: agent.id });
      }}
    />
  );
};

function splitThoughtAndSpeech(message?: string): {
  thoughtText?: string;
  speechText?: string;
} {
  if (!message) {
    return {};
  }
  const thoughtMatch = message.match(/<thought>([\s\S]*?)<\/thought>/i);
  const thoughtText = thoughtMatch?.[1]?.trim();
  const speechText = message
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
    .replace(/<\/?response>/gi, "")
    .trim();
  if (thoughtText && speechText) {
    return { thoughtText, speechText };
  }
  if (thoughtText) {
    return { thoughtText };
  }
  if (speechText) {
    return { speechText };
  }
  return {};
}
