

export async function verifyProof(baseUrl: string, _textID: string, proof: string) {
    const response = await fetch(`${baseUrl}/api/verify`, {
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(proof),
        method: "POST",
    });
    if (!response.ok) {
        throw new Error(`Failed to verify proof: ${response.statusText}`);
    }
    return await response.json();
}
