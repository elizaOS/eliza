# Eliza Docker Setup Guide

This guide provides instructions for installing and running the Eliza chatbot using either Docker or direct installation on a server.

## Prerequisites

- A Linux-based server (Ubuntu/Debian recommended)
- Git installed
- Docker (optional, for containerized deployment)

1. **Install NVM**:

    ```bash
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash
    source ~/.bashrc
    nvm install v23.3.0
    ```

2. **Install Build Essentials** (Optional):

    ```bash
    apt install -y build-essential
    ```

3. **Install PNPM**:
    ```bash
    curl -fsSL https://get.pnpm.io/install.sh | sh -
    source /root/.bashrc
    ```

## Docker Installation

1. **Install Docker**:

    ```bash
    # Add Docker's official GPG key
    sudo apt-get update
    sudo apt-get install ca-certificates curl
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc

    # Add Docker repository
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    # Install Docker packages
    sudo apt-get update
    sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    ```

2. **Clone the Repository**:

    ```bash
    git clone https://github.com/YOUR_USERNAME/eliza.git
    cd eliza
    ```

3. **Configure Environment**:

    ```bash
    cp .env.example .env
    ```

4. **Fix Unix Script Issues** (if needed):

    ```bash
    apt install dos2unix
    dos2unix ./scripts/*
    ```

5. **Run with Docker**:
    ```bash
    pnpm docker
    ```

## Docker Management Commands

- Check running containers:

    ```bash
    docker ps
    ```

- Remove Eliza container:

    ```bash
    docker rm /eliza
    ```

- Restart with a different character:
    ```bash
    pnpm start --character="characters/YOUR_CHARACTER.character.json"
    ```

## Customization

- Modify the `.env` file to customize your bot's settings
- Character files are located in the `characters/` directory
- Create new character files by copying and modifying existing ones

## Troubleshooting

- If Docker container fails to start, check logs:
    ```bash
    docker logs eliza
    ```
- For permission issues, ensure proper file ownership and permissions
- For script formatting issues, run `dos2unix` on problematic files

- Remove All Docker Images
    - Run the following command to delete all images:

```bash
docker rmi -f $(docker images -aq)
```

- Remove All Build Cache
    - To clear the build cache entirely, use:
    ```bash
    docker builder prune -a -f
    ```
- Verify Cleanup
    - Check Docker disk usage again to ensure everything is removed:

```bash
docker system df
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
