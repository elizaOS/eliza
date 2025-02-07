import type { Character } from "@elizaos/core";
import ArrayInput from "@/components/array-input";
import InputCopy from "@/components/input-copy";
import PageTitle from "./page-title";

export default function Overview({ character }: { character: Character }) {
    return (
        <div className="p-4">
            <PageTitle
                title="Overview"
                subtitle="An overview of your selected AI Agent."
            />
            <div className="space-y-4">
                <InputCopy title="Name" value={character?.name} />
                <InputCopy title="Username" value={character?.username} />
                <InputCopy title="System" value={character?.system} />
                <InputCopy title="Model" value={character?.modelProvider} />
                <InputCopy
                    title="Voice Model"
                    value={character?.settings?.voice?.model}
                />
                <ArrayInput
                    title="Bio"
                    data={
                        typeof character?.bio === "object" ? character?.bio : []
                    }
                />
                <ArrayInput
                    title="Lore"
                    data={
                        typeof character?.lore === "object"
                            ? character?.lore
                            : []
                    }
                />
            </div>
        </div>
    );
}
