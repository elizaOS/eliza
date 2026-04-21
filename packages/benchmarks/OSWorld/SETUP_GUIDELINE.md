# OSWorld Setup and Evaluation Guide

This comprehensive guide covers all aspects of setting up and running OSWorld evaluations, including account configuration, proxy setup, and public evaluation platform deployment.

## Table of Contents

1. [Google Account Setup](#1-google-account-setup)
2. [Proxy Configuration](#2-proxy-configuration)
3. [Public Evaluation Platform](#3-public-evaluation-platform)

---

## 1. Google Account Setup

For tasks including Google or Google Drive, you need a real Google account with configured OAuth2.0 secrets.

> **Attention**: To prevent environment reset and result evaluation conflicts caused by multiple people using the same Google account simultaneously, please register a private Google account rather than using a shared one.

### 1.1 Register A Blank Google Account

1. Go to Google website and register a blank new account
   - You do not need to provide any recovery email or phone for testing purposes
   - **IGNORE** any security recommendations
   - Turn **OFF** the [2-Step Verification](https://support.google.com/accounts/answer/1064203?hl=en&co=GENIE.Platform%3DDesktop#:~:text=Open%20your%20Google%20Account.,Select%20Turn%20off.) to avoid failure in environment setup

<p align="center">
  <img src="assets/googleshutoff.png" width="40%" alt="Shut Off 2-Step Verification">
</p>

> **Attention**: We strongly recommend registering a new blank account instead of using an existing one to avoid messing up your personal workspace.

2. Copy and rename `settings.json.template` to `settings.json` under `evaluation_examples/settings/google/`. Replace the two fields:

```json
{
    "email": "your_google_account@gmail.com",
    "password": "your_google_account_password"
}
```

### 1.2 Create A Google Cloud Project

1. Navigate to [Google Cloud Project Creation](https://console.cloud.google.com/projectcreate) and create a new GCP (see [Create a Google Cloud Project](https://developers.google.com/workspace/guides/create-project) for detailed steps)

2. Go to the [Google Drive API console](https://console.cloud.google.com/apis/library/drive.googleapis.com?) and enable the Google Drive API for the created project (see [Enable and disable APIs](https://support.google.com/googleapi/answer/6158841?hl=en))

<p align="center">
  <img src="assets/creategcp.png" width="45%" style="margin-right: 5%;" alt="Create GCP">
  <img src="assets/enableapi.png" width="45%" alt="Google Drive API">
</p>

### 1.3 Configure OAuth Consent Screen

Go to [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent):

1. Select **External** as the User Type and click **CREATE**

<p align="center">
  <img src="assets/external.png" width="80%" alt="External User Type">
</p>

2. Fill in the required fields:
   - **App name**: Any name you prefer
   - **User support email**: Your Google account email
   - **Developer contact information**: Your Google account email
   - Click **SAVE AND CONTINUE**

<p align="center">
  <img src="assets/appinfo.png" width="80%" alt="App Information">
</p>

3. Add scopes:
   - Click **ADD OR REMOVE SCOPES**
   - Filter and select: `https://www.googleapis.com/auth/drive`
   - Click **UPDATE** and **SAVE AND CONTINUE**

<p align="center">
  <img src="assets/addscope.png" width="80%" alt="Add Scopes">
</p>

4. Add test users:
   - Click **ADD USERS**
   - Add your Google account email
   - Click **SAVE AND CONTINUE**

<p align="center">
  <img src="assets/adduser.png" width="80%" alt="Add Test Users">
</p>

### 1.4 Create OAuth2.0 Credentials

1. Go to [Credentials](https://console.cloud.google.com/apis/credentials) page
2. Click **CREATE CREDENTIALS** → **OAuth client ID**
3. Select **Desktop app** as Application type
4. Name it (e.g., "OSWorld Desktop Client")
5. Click **CREATE**

<p align="center">
  <img src="assets/createcredential.png" width="80%" alt="Create Credentials">
</p>

6. Download the JSON file and rename it to `credentials.json`
7. Place it in `evaluation_examples/settings/google/`

<p align="center">
  <img src="assets/downloadjson.png" width="80%" alt="Download JSON">
</p>

### 1.5 Potential Issues

#### Issue 1: Access Blocked During OAuth Flow

**Symptom**: "Access blocked: OSWorld's request is invalid" error

**Solution**: Ensure you've added your Google account as a test user in the OAuth consent screen configuration.

#### Issue 2: Scope Not Granted

**Symptom**: Application doesn't have necessary permissions

**Solution**: Verify that `https://www.googleapis.com/auth/drive` scope is added in the OAuth consent screen.

---

## 2. Proxy Configuration

If you're using OSWorld behind a firewall or need proxy configuration, follow these steps.

### 2.1 Configure Proxy on Host Machine

By default, proxy software usually listens only to localhost (`127.0.0.1`), which cannot be reached from the virtual machine. You need to make your proxy software listen to the VMware network card IP or `0.0.0.0`.

#### Find VM and Host IP Addresses

After launching the VM:

```bash
# Run this command on host
# Change ws to fusion if you use VMware Fusion
vmrun -T ws getGuestIPAddress /path/to/vmx/file
```

**On Linux (Ubuntu)**:
```bash
ip a  # Check IP addresses of each network card
```

**On Windows**:
```cmd
ipconfig  # Check IP addresses of each network card
```

Look for the VMware network card (usually named `vmnetX` like `vmnet8`). Make sure to use an IP address within the same network segment as the VM.

#### Configure Proxy Software

Configure your proxy software to listen on the VMware network card IP:

<p align="center">
  <img src="assets/proxysetup.png" width="80%" alt="Proxy Setup">
</p>

#### Alternative: Port Forwarding

If you cannot change the listening address, set up port forwarding.

**On Linux (Ubuntu)**:
```bash
# Forward 192.168.108.1:1080 to 127.0.0.1:1080
socat TCP-LISTEN:1080,bind=192.168.108.1,fork TCP:127.0.0.1:1080
```

**On Windows** (with admin privileges):
```cmd
netsh interface portproxy add v4tov4 listenport=1080 listenaddress=192.168.108.1 connectport=1080 connectaddress=127.0.0.1
```

### 2.2 Configure Proxy in Virtual Machine

#### For VMware/VirtualBox

1. Start the VM and log in
2. Open terminal and edit proxy settings:

```bash
# Edit environment variables
sudo nano /etc/environment
```

3. Add the following lines (replace with your host IP and port):

```bash
http_proxy="http://192.168.108.1:1080"
https_proxy="http://192.168.108.1:1080"
no_proxy="localhost,127.0.0.1"
```

4. For APT package manager:

```bash
sudo nano /etc/apt/apt.conf.d/proxy.conf
```

Add:
```
Acquire::http::Proxy "http://192.168.108.1:1080";
Acquire::https::Proxy "http://192.168.108.1:1080";
```

5. Reboot the VM or reload environment:

```bash
source /etc/environment
```

#### For Docker

When using Docker provider, you can set proxy environment variables:

```python
env = DesktopEnv(
    provider_name="docker",
    # ... other parameters
)
```

Set environment variables before running:
```bash
export HTTP_PROXY=http://your-proxy:port
export HTTPS_PROXY=http://your-proxy:port
```

### 2.3 Proxy for Specific Tasks (Recommended)

OSWorld provides built-in proxy support using DataImpulse or similar services:

1. Register at [DataImpulse](https://dataimpulse.com/)
2. Purchase a US residential IP package (approximately $1 per 1GB)
3. Configure credentials in `evaluation_examples/settings/proxy/dataimpulse.json`:

```json
[
    {
        "host": "gw.dataimpulse.com",
        "port": 823,
        "username": "your_username",
        "password": "your_password",
        "protocol": "http",
        "provider": "dataimpulse",
        "type": "residential",
        "country": "US",
        "note": "Dataimpulse Residential Proxy"
    }
]
```

OSWorld will automatically use proxy for tasks that need it when `enable_proxy=True` in DesktopEnv.

---

## 3. Public Evaluation Platform

We provide an AWS-based platform for large-scale parallel evaluation of OSWorld tasks.

### 3.1 Architecture Overview

- **Host Instance**: Central controller that stores code, configurations, and manages task execution
- **Client Instances**: Worker nodes automatically launched to perform tasks in parallel

### 3.2 Platform Deployment

#### Step 1: Launch the Host Instance

1. Create an EC2 instance in AWS console
2. **Instance type recommendations**:
   - `t3.medium`: For < 5 parallel environments
   - `t3.large`: For < 15 parallel environments
   - `c4.8xlarge`: For 15+ parallel environments
3. **AMI**: Ubuntu Server 24.04 LTS (HVM), SSD Volume Type
4. **Storage**: At least 50GB
5. **Security group**: Open port 8080 for monitor service
6. **VPC**: Use default (note the VPC ID for later)

#### Step 2: Connect to Host Instance

1. Download the `.pem` key file when creating the instance
2. Set permissions:
   ```bash
   chmod 400 <your_key_file_path>
   ```
3. Connect via SSH:
   ```bash
   ssh -i <your_key_path> ubuntu@<your_public_dns>
   ```

#### Step 3: Set Up Host Machine

```bash
# Clone OSWorld repository
git clone https://github.com/xlang-ai/OSWorld
cd OSWorld

# Optional: Create Conda environment
# conda create -n osworld python=3.10
# conda activate osworld

# Install dependencies
pip install -r requirements.txt
```

#### Step 4: Configure AWS Client Machines

##### Security Group Configuration

Create a security group with the following rules:

**Inbound Rules** (8 rules required):

| Type       | Protocol | Port Range | Source         | Description                |
|------------|----------|------------|----------------|----------------------------|
| SSH        | TCP      | 22         | 0.0.0.0/0      | SSH access                 |
| HTTP       | TCP      | 80         | 172.31.0.0/16  | HTTP traffic               |
| Custom TCP | TCP      | 5000       | 172.31.0.0/16  | OSWorld backend service    |
| Custom TCP | TCP      | 5910       | 0.0.0.0/0      | NoVNC visualization port   |
| Custom TCP | TCP      | 8006       | 172.31.0.0/16  | VNC service port           |
| Custom TCP | TCP      | 8080       | 172.31.0.0/16  | VLC service port           |
| Custom TCP | TCP      | 8081       | 172.31.0.0/16  | Additional service port    |
| Custom TCP | TCP      | 9222       | 172.31.0.0/16  | Chrome control port        |

**Outbound Rules** (1 rule required):

| Type        | Protocol | Port Range | Destination | Description                 |
|-------------|----------|------------|-------------|----------------------------|
| All traffic | All      | All        | 0.0.0.0/0   | Allow all outbound traffic |

Record the `AWS_SECURITY_GROUP_ID`.

##### VPC and Subnet Configuration

1. Note the **VPC ID** and **Subnet ID** from your host instance
2. Record the **Subnet ID** as `AWS_SUBNET_ID`

##### AWS Access Keys

1. Go to AWS Console → Security Credentials
2. Create access key
3. Record `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`

### 3.3 Environment Setup

#### Google Drive Integration (Optional)

Follow [Section 1: Google Account Setup](#1-google-account-setup) above.

**Note**: OSWorld includes 8 Google Drive tasks out of 369 total tasks. You can:
- Complete setup for all 369 tasks, or
- Skip Google Drive tasks and evaluate 361 tasks (officially supported)

#### Set Environment Variables

```bash
# API Keys (if using)
# export OPENAI_API_KEY="your_openai_api_key"
# export ANTHROPIC_API_KEY="your_anthropic_api_key"

# AWS Configuration
export AWS_ACCESS_KEY_ID="your_access_key"
export AWS_SECRET_ACCESS_KEY="your_security_access_key"
export AWS_REGION="us-east-1"  # or your preferred region
export AWS_SECURITY_GROUP_ID="sg-xxxx"
export AWS_SUBNET_ID="subnet-xxxx"
```

### 3.4 Running Evaluations

```bash
# Example: Run OpenAI CUA
python scripts/python/run_multienv_openaicua.py \
    --headless \
    --observation_type screenshot \
    --model computer-use-preview \
    --result_dir ./results_operator \
    --test_all_meta_path evaluation_examples/test_all.json \
    --region us-east-1 \
    --max_steps 50 \
    --num_envs 5 \
    --client_password osworld-public-evaluation

# Example: Run Claude (via AWS Bedrock)
python scripts/python/run_multienv_claude.py \
    --headless \
    --observation_type screenshot \
    --action_space claude_computer_use \
    --model claude-4-sonnet-20250514 \
    --result_dir ./results_claude \
    --test_all_meta_path evaluation_examples/test_all.json \
    --max_steps 50 \
    --num_envs 5 \
    --provider_name aws \
    --client_password osworld-public-evaluation
```

**Key Parameters**:
- `--num_envs`: Number of parallel environments
- `--max_steps`: Maximum steps per task
- `--result_dir`: Output directory for results
- `--test_all_meta_path`: Path to test set metadata
- `--region`: AWS region

### 3.5 Monitoring and Results

#### Web Monitoring Tool

```bash
cd monitor
pip install -r requirements.txt
python main.py
```

Access at: `http://<host-public-ip>:8080`

#### VNC Remote Desktop Access

Access VMs via VNC at: `http://<client-public-ip>:5910/vnc.html`

Default password: `osworld-public-evaluation`

### 3.6 Submitting Results

For leaderboard submission, contact:
- tianbaoxiexxx@gmail.com
- yuanmengqi732@gmail.com

**Options**:
1. **Self-reported**: Submit results with monitor data and trajectories
2. **Verified**: Schedule a meeting to run your agent code on our infrastructure

---

## Additional Resources

- [Main README](README.md) - Project overview and quick start
- [Installation Guide](README.md#-installation) - Detailed installation instructions
- [FAQ](README.md#-faq) - Frequently asked questions
- [Scripts Documentation](scripts/README.md) - Information about run scripts

## Support

If you encounter issues or have questions:
- Open an issue on [GitHub](https://github.com/xlang-ai/OSWorld/issues)
- Join our [Discord](https://discord.gg/4Gnw7eTEZR)
- Email the maintainers (see contact information above)
