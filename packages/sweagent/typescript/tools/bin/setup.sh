#!/bin/bash
# Setup script to build and install Node.js tools

echo "Setting up Node.js tools..."

# Change to tools directory
cd "$(dirname "$0")/.." || exit 1

# Install dependencies
echo "Installing dependencies..."
npm install

# Build TypeScript
echo "Building TypeScript..."
npm run build

# Create symlinks for global usage
echo "Creating executable scripts..."

# Create bin directory if it doesn't exist
mkdir -p bin

# Create wrapper scripts for each tool
cat > bin/registry <<'EOF'
#!/usr/bin/env node
require('../dist/registry/index.js');
EOF
chmod +x bin/registry

cat > bin/diff-state <<'EOF'
#!/usr/bin/env node
require('../dist/diff-state/index.js');
EOF
chmod +x bin/diff-state

cat > bin/str-replace-editor <<'EOF'
#!/usr/bin/env node
require('../dist/edit-anthropic/str-replace-editor.js');
EOF
chmod +x bin/str-replace-editor

cat > bin/view-image <<'EOF'
#!/usr/bin/env node
require('../dist/image-tools/view-image.js');
EOF
chmod +x bin/view-image

cat > bin/search-file <<'EOF'
#!/usr/bin/env node
require('../dist/search/search-file.js');
EOF
chmod +x bin/search-file

cat > bin/search-dir <<'EOF'
#!/usr/bin/env node
require('../dist/search/search-dir.js');
EOF
chmod +x bin/search-dir

cat > bin/find-file <<'EOF'
#!/usr/bin/env node
require('../dist/search/find-file.js');
EOF
chmod +x bin/find-file

cat > bin/submit <<'EOF'
#!/usr/bin/env node
require('../dist/submit/index.js');
EOF
chmod +x bin/submit

cat > bin/exit-forfeit <<'EOF'
#!/usr/bin/env node
require('../dist/forfeit/index.js');
EOF
chmod +x bin/exit-forfeit

cat > bin/filemap <<'EOF'
#!/usr/bin/env node
require('../dist/filemap/index.js');
EOF
chmod +x bin/filemap

cat > bin/windowed-editor <<'EOF'
#!/usr/bin/env node
require('../dist/windowed/index.js');
EOF
chmod +x bin/windowed-editor

cat > bin/web-browser <<'EOF'
#!/usr/bin/env node
require('../dist/web-browser/index.js');
EOF
chmod +x bin/web-browser

echo "Setup complete! Tools are available in tools/bin/"
echo ""
echo "To use the tools globally, add this to your PATH:"
echo "export PATH=\"$(pwd)/bin:\$PATH\""
