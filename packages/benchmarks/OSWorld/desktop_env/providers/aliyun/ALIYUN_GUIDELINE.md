# Aliyun ECS Provider Configuration Guide

This guide explains how to configure and use the Aliyun ECS provider for OSWorld desktop environments.

## Configuration Process

1. **Aliyun Account**: You need an active Aliyun Cloud account. This script uses pay-as-you-go billing by default, so ensure your account balance is above 100.
2. **Access Keys**: Create AccessKey ID and AccessKey Secret in Aliyun RAM Access Control Console and grant ECS control permissions
3. **VPC Setup**: Create a VPC, VSwitch, and Security Group in your target region
4. **Custom Images**: Create OSWorld custom images
5. It is recommended to manually complete the ECS creation process once to record all required environment variable information.

## Environment Variables

Set the following environment variables in your `.env` file:

```bash
# Aliyun Access Credentials
ALIYUN_ACCESS_KEY_ID=your_access_key_id
ALIYUN_ACCESS_KEY_SECRET=your_access_key_secret

# ECS Configuration Information
ALIYUN_REGION=eu-central-1
ALIYUN_IMAGE_ID=your_image_id
ALIYUN_INSTANCE_TYPE=ecs.e-c1m2.large
ALIYUN_VSWITCH_ID=vsw-xxxxxxxxx
ALIYUN_SECURITY_GROUP_ID=sg-xxxxxxxxx
```

## Required Aliyun Resources

### 1. VPC and VSwitch
- Create a VPC in your target region
- Create a VSwitch within the VPC
- Ensure the VSwitch has internet access for VNC connectivity

### 2. Security Group
**⚠️ Important**: Please strictly follow the port settings below to prevent OSWorld tasks from failing due to connection issues:

#### Inbound Rules (8 rules required)

| Type | Protocol | Port Range | Source | Description |
|------|----------|------------|--------|-------------|
| SSH | TCP | 22 | 0.0.0.0/0 | SSH access |
| HTTP | TCP | 80 | 172.31.0.0/16 | HTTP traffic |
| Custom TCP | TCP | 5000 | 172.31.0.0/16 | OSWorld backend service |
| Custom TCP | TCP | 5910 | 0.0.0.0/0 | NoVNC visualization port |
| Custom TCP | TCP | 8006 | 172.31.0.0/16 | VNC service port |
| Custom TCP | TCP | 8080 | 172.31.0.0/16 | VLC service port |
| Custom TCP | TCP | 8081 | 172.31.0.0/16 | Additional service port |
| Custom TCP | TCP | 9222 | 172.31.0.0/16 | Chrome control port |

#### Outbound Rules (1 rule required)

| Type | Protocol | Port Range | Destination | Description |
|------|----------|------------|-------------|-------------|
| All traffic | All | All | 0.0.0.0/0 | Allow all outbound traffic |

### 3. Custom Images
You need to create a custom OSWorld image for Aliyun ECS. Please follow the instructions in the "Creating Custom ECS Images for OSWorld" section.

## Creating Custom ECS Images for OSWorld

This section provides guidance on how to create the custom ECS images required for OSWorld desktop environments. The process involves setting up a base instance with desktop environment and VNC server, then creating a custom image from it.

### Step-by-Step Image Creation Process
#### Step 1: Upload existing qcow2 image to Aliyun
- Download the provided qcow2 image from the link in `desktop_env/providers/docker/manager.py`: https://huggingface.co/datasets/xlangai/ubuntu_osworld/resolve/main/Ubuntu.qcow2.zip
- Unzip the downloaded file and upload it to Aliyun Object Storage Service (OSS). Make sure the OSS is in the same region as your target region to launch ECS instance.
- In your ECS dashboard, go to "Images" and You will see the "Import Image" button. Click it and follow the instructions to import the qcow2 image from OSS.
- After the import is complete, you will see the imported image in the "Images" list.
#### Step 2: Create a new image
Note that the image you created in Step 1 will have a different resolution than the one you want to use for OSWorld (1920x1080). We need to customize the image to have the correct resolution and setup noVNC.
- Go to `Instances` tab and create a new instance with the imported image.
- Connect to the running instance via VNC.
- After connecting to the instance, please open the terminal and download this configuration script: `https://gist.githubusercontent.com/qykong/bea58ff98f20057d3a69921276dd4553/raw/cd1a91a0840c4192d793f43cfb90553370343b08/config.sh`.
- If you want ssh and vnc password also be setup, use this `https://huggingface.co/datasets/xlangai/ubuntu_osworld/resolve/main/aliyun_config.sh?download=true`.
- Run the script and reboot your instance.
- After rebooting, the instance will have the correct resolution and noVNC setup. You can connect to the instance via "http://<your_instance_public_ip>:5910/vnc.html" (make sure your security group allows port 5910).
- Save the running instance as a new image. The new image will be used as the OSWorld image.