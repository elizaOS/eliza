export async function countTokens(text: string): Promise<number> {
  return Math.ceil(text.length / 4);
}
