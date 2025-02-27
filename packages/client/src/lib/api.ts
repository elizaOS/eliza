import type { UUID, Character } from "@elizaos/core";

const BASE_URL = `http://localhost:${import.meta.env.VITE_SERVER_PORT}`;

const fetcher = async ({
    url,
    method,
    body,
    headers,
}: {
    url: string;
    method?: "GET" | "POST" | "DELETE" | "PUT";
    body?: object | FormData;
    headers?: HeadersInit;
}) => {
    const options: RequestInit = {
        method: method ?? "GET",
        headers: headers
            ? headers
            : {
                  Accept: "application/json",
                  "Content-Type": "application/json",
              },
    };

    if (method === "POST") {
        if (body instanceof FormData) {
            if (options.headers && typeof options.headers === 'object') {
                // Create new headers object without Content-Type
                options.headers = Object.fromEntries(
                    Object.entries(options.headers as Record<string, string>)
                        .filter(([key]) => key !== 'Content-Type')
                );
            }
            options.body = body;
        } else {
            options.body = JSON.stringify(body);
        }
    }

    return fetch(`${BASE_URL}${url}`, options).then(async (resp) => {
        const contentType = resp.headers.get('Content-Type');
        if (contentType === "audio/mpeg") {
            return await resp.blob();
        }

        if (!resp.ok) {
            const errorText = await resp.text();
            console.error("Error: ", errorText);

            let errorMessage = "An error occurred.";
            try {
                const errorObj = JSON.parse(errorText);
                errorMessage = errorObj.message || errorMessage;
            } catch {
                errorMessage = errorText || errorMessage;
            }

            throw new Error(errorMessage);
        }
            
        return resp.json();
    });
};

export const apiClient = {
    sendMessage: (
        agentId: string,
        message: string,
        selectedFile?: File | null
    ) => {
        if (selectedFile) {
            // Use FormData only when there's a file
            const formData = new FormData();
            formData.append("text", message);
            formData.append("user", "user");
            formData.append("file", selectedFile);
            
            return fetcher({
                url: `/agents/${agentId}/message`,
                method: "POST",
                body: formData,
            });
        }
            // Use JSON when there's no file
            return fetcher({
                url: `/agents/${agentId}/message`,
                method: "POST",
                body: {
                    text: message,
                    user: "user"
                },
            });
    },
    getAgents: () => fetcher({ url: "/agents" }),
    getAgent: (agentId: string): Promise<{ id: UUID; character: Character }> =>
        fetcher({ url: `/agents/${agentId}` }),
    tts: (agentId: string, text: string) =>
        fetcher({
            url: `/agents/${agentId}/tts`,
            method: "POST",
            body: {
                text,
            },
            headers: {
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
                "Transfer-Encoding": "chunked",
            },
        }),
    whisper: async (agentId: string, audioBlob: Blob) => {
        const formData = new FormData();
        formData.append("file", audioBlob, "recording.wav");
        return fetcher({
            url: `/agents/${agentId}/whisper`,
            method: "POST",
            body: formData,
        });
    },
    deleteAgent: (agentId: string): Promise<{ success: boolean }> =>
        fetcher({ url: `/agents/${agentId}`, method: "DELETE" }),
    updateAgent: (agentId: string, character: Character) =>
        fetcher({
            url: `/agents/${agentId}/set`,
            method: "POST",
            body: character,
        }),
    startAgent: (params: { characterPath?: string; characterJson?: Character }) =>
        fetcher({
            url: "/agents/start",
            method: "POST",
            body: params,
        }),
    startAgentByName: (characterName: string) =>
        fetcher({
            url: `/agents/start/${characterName}`,
            method: "POST",
        }),
    stopAgent: (agentId: string) =>
        fetcher({
            url: `/agents/${agentId}/stop`,
            method: "POST",
        }),
    getMemories: (agentId: string, roomId: string) =>
        fetcher({ url: `/agents/${agentId}/${roomId}/memories` }),
    
    // Character-related routes
    getCharacters: () => 
        fetcher({ url: "/characters" }),
    
    getCharacter: (characterName: string): Promise<Character> =>
        fetcher({ url: `/characters/${characterName}` }),
    
    createCharacter: (character: Character) =>
        fetcher({
            url: "/characters",
            method: "POST",
            body: character,
        }),
    
    updateCharacter: (characterName: string, character: Character) =>
        fetcher({
            url: `/characters/${characterName}`,
            method: "PUT",
            body: character,
        }),
    
    removeCharacter: (characterName: string): Promise<{ success: boolean }> =>
        fetcher({
            url: `/characters/${characterName}`,
            method: "DELETE",
        }),
    
    importCharacter: (characterFile: File) => {
        const formData = new FormData();
        formData.append("file", characterFile);
        return fetcher({
            url: "/characters/import",
            method: "POST",
            body: formData,
        });
    },
    
    exportCharacter: (characterName: string) =>
        fetcher({ url: `/characters/${characterName}/export` }),
};
