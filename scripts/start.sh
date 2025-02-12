#!/usr/bin/env bash
set -e

# Remove pipefail if not running in bash
if [ -n "$BASH_VERSION" ]; then
    set -o pipefail
fi

# Initial variables
NVM_VERSION="v0.39.1"
NODE_VERSION="23.3.0"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
NC='\033[0m'; BOLD='\033[1m'

# Detect OS
detect_os() {
    case "$(uname -s)" in
        Darwin*)
            echo "mac"
            ;;
        Linux*)
            echo "linux"
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

OS_TYPE=$(detect_os)
if [ "$OS_TYPE" = "unknown" ]; then
    echo "Unsupported operating system"
    exit 1
fi

# Basic early logging before any dependencies
early_log() { echo -e "\033[0;34mℹ️  ${1}\033[0m"; }
early_error() { echo -e "\033[0;31m❌ ${1}\033[0m"; }
early_success() { echo -e "\033[0;32m✅ ${1}\033[0m"; }

# Install package manager and gum
install_package_manager() {
    if [ "$OS_TYPE" = "mac" ]; then
        if ! command -v brew &> /dev/null; then
            early_log "Installing Homebrew..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            eval "$(/opt/homebrew/bin/brew shellenv)"
        fi
    fi
}

install_gum() {
    if ! command -v gum &> /dev/null; then
        echo -e "\033[0;34mℹ️  Installing gum for better UI...\033[0m"
        if [ "$OS_TYPE" = "mac" ]; then
            brew install gum
        else
            sudo mkdir -p /etc/apt/keyrings
            curl -fsSL https://repo.charm.sh/apt/gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/charm.gpg
            echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" | sudo tee /etc/apt/sources.list.d/charm.list
            sudo apt update && sudo apt install -y gum
        fi
    fi
}

# Install system dependencies
install_dependencies() {
    log_verbose "Starting system dependency installation..."
    if [ "$OS_TYPE" = "mac" ]; then
        if [ "$VERBOSE" = true ]; then
            brew install git curl python3 ffmpeg
        else
            gum spin --spinner dot --title "Installing system dependencies..." -- \
                brew install git curl python3 ffmpeg
        fi
    else
        if [ "$VERBOSE" = true ]; then
            sudo apt update && sudo apt install -y git curl python3 python3-pip make ffmpeg
        else
            gum spin --spinner dot --title "Installing system dependencies..." -- \
                sudo apt update && sudo apt install -y git curl python3 python3-pip make ffmpeg
        fi
    fi
    log_success "Dependencies installed"
    if [ "$VERBOSE" = true ]; then
        log_verbose "Installed versions:"
        git --version
        curl --version | head -n 1
        python3 --version
        pip3 --version
        ffmpeg -version | head -n 1
    fi
}

# Early NVM setup before anything else
setup_early_nvm() {
    if ! command -v nvm &> /dev/null; then
        early_log "Setting up NVM..."
        # Download and run the nvm installation script
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash

        # Load NVM
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        
        # Verify installation
        if ! command -v nvm &> /dev/null; then
            early_error "Failed to install NVM. Please install it manually:"
            echo "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash"
            exit 1
        fi
        early_success "NVM installed successfully"
    else
        early_success "NVM already installed"
    fi

    # Install required Node version
    if ! nvm install "$NODE_VERSION"; then
        early_error "Failed to install Node.js $NODE_VERSION"
        exit 1
    fi

    if ! nvm use "$NODE_VERSION"; then
        early_error "Failed to use Node.js $NODE_VERSION"
        exit 1
    fi

    # Install bun
    if ! command -v bun &> /dev/null; then
        early_log "Installing bun..."
        if ! npm install -g bun; then
            early_error "Failed to install bun"
            exit 1
        fi
        early_success "bun installed successfully"
    fi
}

# Global variables for process management
SERVER_PID=""
CLIENT_PID=""

# Set up interrupt handling
trap 'cleanup' EXIT INT TERM

# Basic functions first - fallback logging before gum is installed
log_error() { 
    if command -v gum &> /dev/null; then
        gum style --foreground 1 "❌ ${1}"
    else
        echo -e "\033[0;31m❌ ${1}\033[0m"
    fi
}

log_success() {
    if command -v gum &> /dev/null; then
        gum style --foreground 2 "✅ ${1}"
    else
        echo -e "\033[0;32m✅ ${1}\033[0m"
    fi
}

log_info() {
    if command -v gum &> /dev/null; then
        gum style --foreground 4 "ℹ️  ${1}"
    else
        echo -e "\033[0;34mℹ️  ${1}\033[0m"
    fi
}

log_verbose() { 
    if [ "$VERBOSE" = true ]; then
        if command -v gum &> /dev/null; then
            gum style --foreground 3 "🔍 ${1}"
        else
            echo -e "\033[1;33m🔍 ${1}\033[0m"
        fi
    fi
}

# Cleanup function
cleanup() {
    log_verbose "Cleaning up..."
    [ -n "$SERVER_PID" ] && kill $SERVER_PID 2>/dev/null || true
    [ -n "$CLIENT_PID" ] && kill $CLIENT_PID 2>/dev/null || true
}

# Command line argument parsing
VERBOSE=false
SKIP_NVM=false
while [ $# -gt 0 ]; do
    case $1 in
        -v|--verbose) VERBOSE=true; shift ;;
        --skip-nvm) SKIP_NVM=true; shift ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
done

# Error handling
handle_error() { 
    log_error "Error occurred in: $1"
    log_error "Exit code: $2"
    if [ "$VERBOSE" = true ]; then
        log_error "Stack trace:"
        caller
    fi
    exit 1
}

show_welcome() {
    clear
    cat << "EOF"
 EEEEEE LL    IIII ZZZZZZZ  AAAA
 EE     LL     II      ZZ  AA  AA
 EEEE   LL     II    ZZZ   AAAAAA
 EE     LL     II   ZZ     AA  AA
 EEEEEE LLLLL IIII ZZZZZZZ AA  AA

Eliza is an open-source AI agent.
     Created by ai16z 2024.
     
EOF
}

setup_environment() {
    log_verbose "Setting up environment..."
    if [ ! -f .env ]; then
        if [ ! -f .env.example ]; then
            log_error "No .env.example file found"
            exit 1
        fi
        if ! cp .env.example .env; then
            log_error "Failed to create .env file"
            exit 1
        fi
        log_success "Environment file created"
    else
        log_info "Environment file already exists"
    fi
}

create_character_template() {
    local name="$1"
    cat > "$2" << EOF
{
    "name": "$name",
    "clients": [],
    "settings": {
        "voice": {
            "model": "en_GB-alan-medium"
        }
    },
    "plugins": [],
    "bio": [
        "Brief description of the character",
        "Key personality traits",
        "Main purpose or role",
        "Notable characteristics"
    ],
    "lore": [
        "Background information",
        "Important history",
        "Key relationships",
        "Significant attributes"
    ],
    "knowledge": [
        "Area of expertise 1",
        "Area of expertise 2",
        "Area of expertise 3",
        "Area of expertise 4"
    ],
    "messageExamples": [
        [
            {
                "user": "{{user1}}",
                "content": {
                    "text": "Can you help me with this task?"
                }
            },
            {
                "user": "$name",
                "content": {
                    "text": "Example response showing character's personality"
                }
            }
        ],
        [
            {
                "user": "{{user1}}",
                "content": {
                    "text": "This seems difficult."
                }
            },
            {
                "user": "$name",
                "content": {
                    "text": "Another example response in character's style"
                }
            }
        ]
    ],
    "postExamples": [
        "Example of a social media post in character's voice",
        "Another example showing typical posting style"
    ],
    "topics": [""],
    "style": {
        "all": [
            "Primary trait",
            "Secondary trait",
            "Third trait",
            "Fourth trait"
        ],
        "chat": [
            "Chat-specific trait",
            "Another chat trait",
            "Third chat trait"
        ],
        "post": [
            "Posting style 1",
            "Posting style 2",
            "Posting style 3"
        ]
    },
    "adjectives": [
        "Descriptive1",
        "Descriptive2",
        "Descriptive3",
        "Descriptive4",
        "Descriptive5"
    ]
}
EOF
}

select_character() {
    # Check if characters directory exists
    if [ ! -d "./characters" ]; then
        log_error "Characters directory not found"
        return 1
    fi

    # Get list of character files using POSIX-compatible syntax
    characters=""
    character_paths=""
    for file in ./characters/*.character.json; do
        if [ -f "$file" ]; then
            character_paths="$character_paths $file"
            name=$(basename "$file" .character.json)
            characters="$characters $name"
        fi
    done

    while true; do
        # Instructions for user
        log_info "Select character(s):"
        log_info "(Use Ctrl+Space for multiple, Ctrl+A for all, Enter to confirm)"

        # Show initial menu options
        initial_choice=$(printf "Create New\nUse Existing" | gum choose --limit 1)
        
        case "$initial_choice" in
            "Create New")
                # Get new character name
                log_info "Enter name for new character (without spaces):"
                new_name=$(gum input --placeholder "character_name")
                
                if [ -z "$new_name" ]; then
                    log_error "No name provided"
                    continue
                fi

                # Create new character file
                new_file="./characters/${new_name}.character.json"
                if [ -f "$new_file" ]; then
                    log_error "Character file already exists"
                    continue
                fi

                # Create new character from template
                create_character_template "$new_name" "$new_file"
                
                # Open the new file for editing
                log_success "Created new character file. Opening for editing..."
                nano "$new_file"
                
                # Add to current list
                characters="$characters $new_name"
                character_paths="$character_paths $new_file"
                continue
                ;;
            "Use Existing")
                # Show character list for multi-select
                selected_names=$(printf "%s\n" $characters | gum choose --no-limit)
                
                # If no selection made, use the highlighted character
                if [ -z "$selected_names" ]; then
                    # Get the first visible character (highlighted one)
                    selected_names=$(printf "%s\n" $characters | head -n 1)
                    if [ -z "$selected_names" ]; then
                        log_error "No characters available"
                        continue
                    fi
                fi

                # Show action menu based on selection count
                char_count=$(echo "$selected_names" | wc -l)
                if [ "$char_count" -gt 1 ]; then
                    # Multiple characters - only show Run/Delete options
                    action=$(printf "Run\nDelete" | gum choose --limit 1)
                else
                    # Single character - show all options
                    action=$(printf "Run\nEdit\nDelete" | gum choose --limit 1)
                fi
                
                case "$action" in
                    "Delete")
                        # Delete logic here
                        ;;
                    "Edit")
                        # Count selected characters
                        char_count=$(echo "$selected_names" | wc -l)
                        
                        if [ "$char_count" -gt 1 ]; then
                            # Edit each selected character
                            echo "$selected_names" | while read -r name; do
                                for file in $character_paths; do
                                    base_name=$(basename "$file" .character.json)
                                    if [ "$base_name" = "$name" ]; then
                                        log_info "Editing character: $name"
                                        nano "$file"
                                        break
                                    fi
                                done
                            done
                            log_success "Characters edited. Please select character(s) to continue:"
                        else
                            # Single character edit
                            for file in $character_paths; do
                                base_name=$(basename "$file" .character.json)
                                if [ "$base_name" = "$selected_names" ]; then
                                    log_info "Editing character: $selected_names"
                                    nano "$file"
                                    log_success "Character edited. Please select character(s) to continue:"
                                    break
                                fi
                            done
                        fi
                        continue
                        ;;
                    "Run")
                        # Convert selected names to paths
                        selected_paths=""
                        first=true
                        # Save selected_names to a temp file to preserve it across the pipe
                        echo "$selected_names" > /tmp/eliza_selected_names
                        while read -r name; do
                            for file in $character_paths; do
                                base_name=$(basename "$file" .character.json)
                                if [ "$base_name" = "$name" ]; then
                                    if [ "$first" = true ]; then
                                        selected_paths="$file"
                                        first=false
                                    else
                                        selected_paths="$selected_paths,$file"
                                    fi
                                    break
                                fi
                            done
                        done < /tmp/eliza_selected_names
                        rm -f /tmp/eliza_selected_names

                        if [ -n "$selected_paths" ]; then
                            selected_character_path="$selected_paths"
                            log_success "Selected characters: $selected_names"
                            return 0
                        fi
                        ;;
                esac
                ;;
            *)
                log_error "Invalid choice"
                continue
                ;;
        esac
    done
}

start_eliza() {
    # Ask about editing environment configuration first
    log_info "Would you like to configure API secrets in .env?"
    if gum confirm "Edit .env file?"; then
        if [ ! -f ".env" ]; then
            log_error "No .env file found"
            return 1
        fi
        nano ".env"
        log_success "Environment configuration updated"
    fi

    # Add character selection before starting
    if ! select_character; then
        log_error "Failed to select character"
        return 1
    fi
    
    log_info "Starting Eliza..."
    
    # Start server with selected character(s)
    bun start --characters="$selected_character_path" &
    SERVER_PID=$!
    sleep 2
    
    # Check if server started successfully
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        log_error "Failed to start Eliza server"
        return 1
    fi
    
    # Start client
    bun start:client &
    CLIENT_PID=$!
    sleep 3
    
    # Check if client started successfully
    if ! kill -0 $CLIENT_PID 2>/dev/null; then
        log_error "Failed to start Eliza client"
        kill $SERVER_PID 2>/dev/null
        return 1
    fi

    # Open in browser
    log_info "Opening Eliza in your browser..."
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "http://localhost:5173"
    elif command -v open >/dev/null 2>&1; then
        open "http://localhost:5173"
    else
        log_info "Please open http://localhost:5173 in your browser"
    fi

    log_success "Eliza is now running"
    log_info "Press Ctrl+C to stop Eliza"
    
    # Wait for both processes
    wait $SERVER_PID $CLIENT_PID
    return 0
}

build_and_start() {
    log_verbose "Starting build process..."
    
    # Check Node.js version
    REQUIRED_NODE_VERSION=22
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed or not in PATH"
        exit 1
    fi
    
    CURRENT_NODE_VERSION=$(node -v | cut -d'.' -f1 | sed 's/v//')
    if [ "$(expr "$CURRENT_NODE_VERSION" \< "$REQUIRED_NODE_VERSION")" -eq 1 ]; then
        log_error "Node.js version must be $REQUIRED_NODE_VERSION or higher. Current version is $CURRENT_NODE_VERSION."
        exit 1
    fi

    # Check for bun
    if ! command -v bun &> /dev/null; then
        log_error "bun is not installed. Please install bun before running the script."
        exit 1
    fi

    # INSTALL
    log_verbose "Installing dependencies..."
    if ! bun install; then
        log_error "Failed to install dependencies"
        exit 1
    fi
    log_success "Dependencies installed"

    log_verbose "Building project..."
    if ! bun run build; then
        log_error "Failed to build project"
        exit 1
    fi
    log_success "Project built successfully"

    start_eliza
}

check_existing_installation() {
    log_verbose "Checking for existing installation..."
    
    # Check for required files and dependencies
    if [ -f ".env" ] && [ -d "node_modules" ]; then
        # Load NVM if available
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        
        # Check for required commands
        if command -v node &> /dev/null && command -v bun &> /dev/null; then
            # Verify Node.js version
            REQUIRED_NODE_VERSION=22
            CURRENT_NODE_VERSION=$(node -v | cut -d'.' -f1 | sed 's/v//')
            
            if [ "$(expr "$CURRENT_NODE_VERSION" '>=' "$REQUIRED_NODE_VERSION")" -eq 1 ]; then
                log_info "Existing installation detected"
                
                # Show options menu
                action=$(printf "Start\nUpdate\nReinstall" | gum choose --limit 1)

                case "$action" in
                    "Start")
                        start_eliza
                        exit 0
                        ;;
                    "Update")
                        log_info "Checking for updates..."
                        
                        # Fetch latest changes
                        if ! git fetch origin; then
                            log_error "Failed to fetch updates"
                            return 1
                        fi

                        # Check if we're behind origin
                        LOCAL=$(git rev-parse @)
                        REMOTE=$(git rev-parse @{u})

                        if [ "$LOCAL" = "$REMOTE" ]; then
                            log_success "Already up to date"
                            
                            # Ask to start
                            if gum confirm "Would you like to start Eliza now?"; then
                                start_eliza
                                exit 0
                            fi
                            exit 0  # Exit instead of return if user chooses not to start
                        fi
                        
                        # If we get here, there are updates
                        log_info "Updates available. Updating Eliza..."
                        
                        # Pull latest changes
                        if ! git pull; then
                            log_error "Failed to pull updates"
                            return 1
                        fi
                        
                        # Install any new dependencies
                        if ! bun install; then
                            log_error "Failed to update dependencies"
                            return 1
                        fi
                        
                        # Rebuild
                        if ! bun run build; then
                            log_error "Failed to rebuild after update"
                            return 1
                        fi
                        
                        log_success "Update completed"
                        
                        # Ask to start
                        if gum confirm "Would you like to start Eliza now?"; then
                            start_eliza
                            exit 0
                        fi
                        exit 0  # Exit instead of return if user chooses not to start
                        ;;
                    "Reinstall")
                        return 0  # Continue with fresh installation
                        ;;
                esac
            fi
        fi
    fi
    
    log_verbose "No valid installation found"
    return 0
}

# Install NVM function
install_nvm() {
    log_verbose "Installing NVM..."
    
    if ! command -v nvm &> /dev/null; then
        # Download and run the nvm installation script
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash
        
        # Load NVM
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        
        # Verify installation
        if ! command -v nvm &> /dev/null; then
            log_error "Failed to install NVM. Please install it manually:"
            echo "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash"
            exit 1
        fi
        log_success "NVM installed"
    else
        log_success "NVM already installed"
    fi

    # Install required Node version
    if ! nvm install "$NODE_VERSION"; then
        log_error "Failed to install Node.js $NODE_VERSION"
        exit 1
    fi

    if ! nvm use "$NODE_VERSION"; then
        log_error "Failed to use Node.js $NODE_VERSION"
        exit 1
    fi

    log_success "Node.js setup complete"
    
    if [ "$VERBOSE" = true ]; then
        log_verbose "Node version: $(node -v)"
        log_verbose "NPM version: $(npm -v)"
    fi
}

# Setup Node.js environment
setup_node() {
    log_verbose "Setting up Node.js environment..."
    
    # Verify Node.js installation
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed"
        exit 1
    fi
    
    # Install bun if not present
    if ! command -v bun &> /dev/null; then
        log_info "Installing bun..."
        if ! curl -fsSL https://bun.sh/install | bash; then
            log_error "Failed to install bun"
            exit 1
        fi
        log_success "bun installed"
    fi
    
    # Verify versions
    if [ "$VERBOSE" = true ]; then
        log_verbose "Node version: $(node -v)"
        log_verbose "npm version: $(npm -v)"
        log_verbose "bun version: $(bun -v)"
    fi
    
    log_success "Node.js environment setup complete"
}

main() {
    early_log "Detected operating system: $OS_TYPE"
    
    # Install package manager first (for macOS)
    install_package_manager
    
    # Install gum before any other operations
    install_gum
    
    show_welcome
    [ "$VERBOSE" = true ] && log_verbose "Running in verbose mode"

    # Add the installation check here
    check_existing_installation

    if ! gum confirm "Ready to install Eliza?"; then
        log_info "Installation cancelled"
        exit 0
    fi

    install_dependencies
    
    if [ "$SKIP_NVM" = false ]; then
        install_nvm
    fi

    setup_node
    setup_environment
    build_and_start

    # This will only be reached after Ctrl+C or error
    log_info "Eliza has been stopped"
}

# Call main function
main "$@" 