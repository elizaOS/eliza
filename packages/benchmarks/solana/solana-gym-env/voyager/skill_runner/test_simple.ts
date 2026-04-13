export async function executeSkill(env: any): Promise<[number, string, string | null]> {
    const receipt = await env.simulateTransaction();
    return [1.0, "success", receipt];
}