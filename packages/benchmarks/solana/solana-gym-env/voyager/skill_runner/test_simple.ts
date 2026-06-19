interface SkillEnvironment {
  simulateTransaction(): Promise<string>;
}

export async function executeSkill(
  env: SkillEnvironment,
): Promise<[number, string, string | null]> {
  const receipt = await env.simulateTransaction();
  return [1.0, "success", receipt];
}
