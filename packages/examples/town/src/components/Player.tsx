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
  const fields = parseThoughtSpeechToon(message);
  const thoughtText = fields.thought?.trim();
  const speechText = (fields.text ?? message).trim();
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

function parseThoughtSpeechToon(message: string): {
  thought?: string;
  text?: string;
} {
  const fields: { thought?: string; text?: string } = {};
  let currentKey: "thought" | "text" | undefined;
  for (const line of message.split(/\r?\n/)) {
    const fieldMatch = line.match(/^(thought|text):\s*(.*)$/i);
    if (fieldMatch) {
      currentKey = fieldMatch[1].toLowerCase() as "thought" | "text";
      fields[currentKey] = fieldMatch[2];
      continue;
    }
    if (currentKey) {
      fields[currentKey] = `${fields[currentKey] ?? ""}\n${line}`;
    }
  }
  return fields;
}
