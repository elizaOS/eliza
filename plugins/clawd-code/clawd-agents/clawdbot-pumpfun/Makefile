# Variables
TARGET_X86_64 = x86_64-pc-windows-gnu
TARGET_I686 = i686-pc-windows-gnu
PROJECT_NAME = solana-vntr-sniper # Change this to your project name
CARGO = cargo

# Target to install prerequisites
.PHONY: install
install:
	sudo apt update
	sudo apt install -y mingw-w64
	rustup target add $(TARGET_X86_64)
	rustup target add $(TARGET_I686)

# pm2 to install prerequisites
.PHONY: pm2
pm2:
	pm2 start target/release/solana-vntr-sniper

# Target to build for x86_64 Windows
.PHONY: build-x86_64
build-x86_64:
	$(CARGO) build --target=$(TARGET_X86_64) --release

# Target to build for i686 Windows
.PHONY: build-i686
build-i686:
	$(CARGO) build --target=$(TARGET_I686) --release

# Target to clean the project
.PHONY: clean
clean:
	$(CARGO) clean

# Start the server
.PHONY: start
start:
	pm2 start 0

# Stop the server
.PHONY: stop
stop:
	pm2 stop 0

# Stop the server
.PHONY: build
build:
	$(CARGO) clean
	$(CARGO) build -r

# Target to display help
.PHONY: help
help:
	@echo "Makefile commands:"
	@echo "  install       - Install necessary packages and configure Rust targets"
	@echo "  build-x86_64  - Build for 64-bit Windows"
	@echo "  build-i686    - Build for 32-bit Windows"
	@echo "  clean         - Clean the target directory"
	@echo "  help          - Display this help message"
	@echo "  start         - Start the server"
	@echo "  stop          - Stop the server"
	@echo "  build         - Build the server"
