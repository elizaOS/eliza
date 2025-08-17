#!/bin/bash

# ElizaOS Organized Report Generator
# NOW SIMPLIFIED - Default behavior automatically creates organized reports!

set -e

echo "🚀 ElizaOS Organized Report Generator"
echo "===================================="
echo ""
echo "✨ NEW: This is now the DEFAULT behavior!"
echo "   Just run: elizaos report generate <input_dir>"
echo ""

echo "📊 Generating organized reports using DEFAULT behavior..."

# Generate all formats using the new default behavior (now reads from simplified scenario/_logs_)
_ELIZA_CLI_DELEGATION_DEPTH=1 ./packages/cli/dist/index.js report generate packages/cli/src/commands/scenario/_logs_

echo ""
echo "✅ Report generation complete!"
echo ""
echo "📁 Check the timestamped folder in: packages/cli/src/commands/scenario/_logs_/"
echo "🌐 Open the report.html file for interactive viewing"
echo ""
echo "💡 Pro Tips:"
echo "  • Default behavior: elizaos report generate <dir>  →  All formats in organized folder"
echo "  • Specific format: elizaos report generate <dir> --format json  →  Single file" 
echo "  • Custom location: elizaos report generate <dir> --format all --output-path <path>"
echo ""
echo "📁 SIMPLIFIED: All scenario logs are now organized under @scenario/_logs_/"
