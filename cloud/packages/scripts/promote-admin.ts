#!/usr/bin/env bun

/**
 * Script to promote wallet addresses to admin
 *
 * Usage:
 *   bun run packages/scripts/promote-admin.ts <wallet_address> [role] [notes]
 *
 * Arguments:
 *   wallet_address - The wallet address to promote (required)
 *   role           - Admin role: super_admin, moderator, viewer (default: moderator)
 *   notes          - Optional notes about why this admin was added
 *
 * Examples:
 *   bun run packages/scripts/promote-admin.ts 0x1234...5678
 *   bun run packages/scripts/promote-admin.ts 0x1234...5678 super_admin
 *   bun run packages/scripts/promote-admin.ts 0x1234...5678 moderator "Promoted by Shaw"
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
Admin Promotion Script
======================

Usage:
  bun run packages/scripts/promote-admin.ts <wallet_address> [role] [notes]

Arguments:
  wallet_address  The wallet address to promote (required)
  role            Admin role: super_admin, moderator, viewer (default: moderator)
  notes           Optional notes about why this admin was added

Examples:
  bun run packages/scripts/promote-admin.ts 0x1234...5678
  bun run packages/scripts/promote-admin.ts 0x1234...5678 super_admin
  bun run packages/scripts/promote-admin.ts 0x1234...5678 moderator "Promoted by Shaw"

Special Commands:
  --list          List all current admins
  --revoke <addr> Revoke admin privileges for a wallet
`);
    process.exit(0);
  }

  const { adminService } = await import("@/lib/services/admin");

  // Handle --list command
  if (args[0] === "--list") {
    console.log("\n📋 Current Admins:\n");
    const admins = await adminService.listAdmins();

    if (admins.length === 0) {
      console.log("  No admins found.");
    } else {
      for (const admin of admins) {
        console.log(`  • ${admin.walletAddress}`);
        console.log(`    Role: ${admin.role}`);
        console.log(`    Active: ${admin.isActive}`);
        if (admin.notes) console.log(`    Notes: ${admin.notes}`);
        console.log(`    Created: ${admin.createdAt.toISOString()}`);
        console.log();
      }
    }

    process.exit(0);
  }

  // Handle --revoke command
  if (args[0] === "--revoke") {
    const walletAddress = args[1];
    if (!walletAddress) {
      console.error("❌ Error: Wallet address required for --revoke");
      process.exit(1);
    }

    await adminService.revokeAdmin(walletAddress);
    console.log(`\n✅ Revoked admin privileges for: ${walletAddress}\n`);
    process.exit(0);
  }

  // Promote admin
  const walletAddress = args[0];
  const role = (args[1] as "super_admin" | "moderator" | "viewer") || "moderator";
  const notes = args.slice(2).join(" ") || undefined;

  // Validate wallet address format
  if (!walletAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    console.error(
      "❌ Error: Invalid wallet address format. Must be 0x followed by 40 hex characters.",
    );
    process.exit(1);
  }

  // Validate role
  const validRoles = ["super_admin", "moderator", "viewer"];
  if (!validRoles.includes(role)) {
    console.error(`❌ Error: Invalid role. Must be one of: ${validRoles.join(", ")}`);
    process.exit(1);
  }

  console.log(`\n🔐 Promoting wallet to admin...`);
  console.log(`   Wallet: ${walletAddress}`);
  console.log(`   Role: ${role}`);
  if (notes) console.log(`   Notes: ${notes}`);
  console.log();

  const admin = await adminService.promoteToAdmin({
    walletAddress,
    role,
    notes,
    grantedByWallet: "script",
  });

  console.log(`✅ Successfully promoted to admin!`);
  console.log(`   ID: ${admin.id}`);
  console.log(`   Wallet: ${admin.walletAddress}`);
  console.log(`   Role: ${admin.role}`);
  console.log();

  process.exit(0);
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
