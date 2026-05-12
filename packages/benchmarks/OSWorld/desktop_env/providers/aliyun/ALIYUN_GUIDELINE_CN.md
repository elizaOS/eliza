# 阿里云ECS提供商配置指南

本指南介绍如何为OSWorld桌面环境配置和使用阿里云ECS。

## 配置流程

1. **阿里云账户**：您需要一个有效的阿里云账户，本脚本默认ECS通过按量付费方式拉起，需保证账户余额在100以上。
2. **访问密钥**：在阿里云RAM访问控制控制台中创建AccessKey ID和AccessKey Secret，并授权ECS控制权限
3. **VPC设置**：在目标地域创建VPC、交换机和安全组
4. **自定义镜像**：创建OSWorld自定义镜像。
5. 建议手动完成一次ECS创建流程后，记录所有需要的环境变量信息。

## 环境变量

在您的`.env`文件中设置以下环境变量：

```bash
# 阿里云访问凭证
ALIYUN_ACCESS_KEY_ID=your_access_key_id
ALIYUN_ACCESS_KEY_SECRET=your_access_key_secret

# ECS配置信息
ALIYUN_REGION=eu-central-1
ALIYUN_IMAGE_ID=your_image_id
ALIYUN_INSTANCE_TYPE=ecs.e-c1m2.large
ALIYUN_VSWITCH_ID=vsw-xxxxxxxxx
ALIYUN_SECURITY_GROUP_ID=sg-xxxxxxxxx
```

## 所需阿里云资源

### 1. VPC和交换机
- 在目标地域创建VPC
- 在VPC内创建交换机
- 确保交换机具有互联网访问能力以支持VNC连接

### 2. 安全组
**⚠️ 重要提示**：请严格按照以下端口设置，以防止OSWorld任务因连接问题而失败：

#### 入方向规则（需要8条规则）

| 类型 | 协议 | 端口范围 | 源地址 | 描述 |
|------|------|----------|--------|------|
| SSH | TCP | 22 | 0.0.0.0/0 | SSH访问 |
| HTTP | TCP | 80 | 172.31.0.0/16 | HTTP流量 |
| 自定义TCP | TCP | 5000 | 172.31.0.0/16 | OSWorld后端服务 |
| 自定义TCP | TCP | 5910 | 0.0.0.0/0 | NoVNC可视化端口 |
| 自定义TCP | TCP | 8006 | 172.31.0.0/16 | VNC服务端口 |
| 自定义TCP | TCP | 8080 | 172.31.0.0/16 | VLC服务端口 |
| 自定义TCP | TCP | 8081 | 172.31.0.0/16 | 附加服务端口 |
| 自定义TCP | TCP | 9222 | 172.31.0.0/16 | Chrome控制端口 |

#### 出方向规则（需要1条规则）

| 类型 | 协议 | 端口范围 | 目标地址 | 描述 |
|------|------|----------|----------|------|
| 全部流量 | 全部 | 全部 | 0.0.0.0/0 | 允许所有出站流量 |

### 3. 自定义镜像
您需要为阿里云ECS创建自定义OSWorld镜像。请按照"为OSWorld创建自定义ECS镜像"部分的说明进行操作。


## 为OSWorld创建自定义ECS镜像

本部分提供如何创建OSWorld桌面环境所需的自定义ECS镜像的指导。该过程包括设置带有桌面环境和VNC服务器的基础实例，然后从中创建自定义镜像。

### 分步镜像创建过程
#### 步骤1：上传现有qcow2镜像到阿里云
- 从`desktop_env/providers/docker/manager.py`中的链接下载提供的qcow2镜像：https://huggingface.co/datasets/xlangai/ubuntu_osworld/resolve/main/Ubuntu.qcow2.zip
- 解压下载的文件并上传到阿里云对象存储服务（OSS）。确保OSS与您要启动ECS实例的目标地域在同一地域。
- 在您的ECS控制台中，转到"镜像"页面，您将看到"导入镜像"按钮。点击它并按照说明从OSS导入qcow2镜像。
- 导入完成后，您将在"镜像"列表中看到导入的镜像。

#### 步骤2：创建新镜像
请注意，您在步骤1中创建的镜像分辨率与您想要用于OSWorld的分辨率（1920x1080）不同。我们需要自定义镜像以具有正确的分辨率并设置noVNC。
- 转到"实例"选项卡，使用导入的镜像创建新实例。
- 通过VNC连接到正在运行的实例。
- 连接到实例后，请打开终端并下载此配置脚本：`https://gist.githubusercontent.com/qykong/bea58ff98f20057d3a69921276dd4553/raw/cd1a91a0840c4192d793f43cfb90553370343b08/config.sh`。
- 如果您还想设置ssh和vnc密码，请使用此脚本 `https://huggingface.co/datasets/xlangai/ubuntu_osworld/resolve/main/aliyun_config.sh?download=true`。
- 运行脚本并重启您的实例。
- 重启后，实例将具有正确的分辨率和noVNC设置。您可以通过"http://<your_instance_public_ip>:5910/vnc.html"连接到实例（确保您的安全组允许端口5910）。
- 将正在运行的实例保存为新镜像。新镜像将用作OSWorld镜像。
