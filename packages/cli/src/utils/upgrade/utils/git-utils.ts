import { execa } from 'execa';

export async function getCurrentBranch(repoPath: string): Promise<string> {
  const result = await execa('git', ['branch', '--show-current'], {
    cwd: repoPath,
  });
  return result.stdout.trim();
}

export async function createBranch(repoPath: string, branchName: string): Promise<void> {
  await execa('git', ['checkout', '-b', branchName], {
    cwd: repoPath,
  });
}

export async function checkoutBranch(repoPath: string, branchName: string): Promise<void> {
  await execa('git', ['checkout', branchName], {
    cwd: repoPath,
  });
}

export async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await execa('git', ['rev-parse', '--verify', branchName], {
      cwd: repoPath,
    });
    return true;
  } catch {
    return false;
  }
}
