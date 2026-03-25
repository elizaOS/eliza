/**
 * ElizaOS Universal Character File Format.
 * Standardizes personality, lore, and memory for AGI portability.
 */
export interface UniversalCharacter {
    id: string;
    identity: {
        name: string;
        persona: string;
        voice: string;
    };
    knowledge: string[];
    lore: string[];
    treasury?: {
        chain: string;
        address: string;
    };
    memory_sync_protocol: "v1" | "v2";
}

export class CharacterPorter {
    static export(character: UniversalCharacter): string {
        console.log("STRIKE_VERIFIED: Exporting universal character profile.");
        return JSON.stringify(character);
    }
}
