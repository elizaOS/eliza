import { ethers } from 'ethers';

/**
 * Represents the ALI token requirement for each iNFT intelligence level.
 * The amounts are cumulative and must be provided in wei.
 */
export const LEVEL_THRESHOLDS = [
  { level: 1, aliRequired: ethers.parseEther('0') }, // Base level
  { level: 2, aliRequired: ethers.parseEther('3000') }, // 3k ALI
  { level: 3, aliRequired: ethers.parseEther('33000') }, // 3k + 30k ALI
  { level: 4, aliRequired: ethers.parseEther('1113000') }, // 33k + 1.08M ALI
];

/**
 * Calculates an iNFT's intelligence level based on the total amount of ALI tokens locked.
 * @param totalAliLocked The total amount of ALI locked for the iNFT, in wei.
 * @returns The calculated intelligence level.
 */
export function calculateLevelFromAliLocked(totalAliLocked: ethers.BigNumberish): number {
  const totalAliBigNumber = ethers.toBigInt(totalAliLocked);
  // Find the highest level the iNFT has achieved
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (totalAliBigNumber >= LEVEL_THRESHOLDS[i].aliRequired) {
      return LEVEL_THRESHOLDS[i].level;
    }
  }
  // Default to level 0 or 1 if no threshold is met, assuming level 1 is the base.
  return 1;
}
