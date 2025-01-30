type TextResponse = {
    text: string;
    user: string;
    attachments?: { url: string; contentType: string; title: string }[];
};

export async function sendMessage({
    agentId,
    text,
}: {
    agentId: string;
    text: string;
}): Promise<TextResponse[]> {
    if (!text.trim()) {
        throw new Error("Message text is required.");
    }
    const userId = "user";
    const roomId = `default-room-${agentId}`;
    const requestBody = {
        text,
        userId,
        roomId,
    };
    try {
        const BASE_URL = "http://localhost:3000";
        const response = await fetch(`${BASE_URL}/${agentId}/message`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
            throw new Error(`Failed to send message: ${response.statusText}`);
        }
        const data = (await response.json()) as TextResponse[];
        return data;
    } catch (error) {
        console.error("[sendMessage]:", error);
        throw error;
    }
}
