| Announcements |
|-|
| [[Ubuntu] `ubuntu-latest` label will use Ubuntu 26.04 in November 2026](https://github.com/actions/runner-images/issues/14748) |
| [[Ubuntu] Ubuntu 26.04 and Ubuntu 26.04 Arm64 are now generally available](https://github.com/actions/runner-images/issues/14747) |
| [[Ubuntu] The Ubuntu 22 based runner images will begin deprecation on September 17th and will be fully unsupported by April 17th for GitHub Actions and Azure DevOps](https://github.com/actions/runner-images/issues/14254) |
| [[Ubuntu] Ubuntu 26.04 and Ubuntu 26.04 Arm is now available as a public preview](https://github.com/actions/runner-images/issues/14226) |
***
# Ubuntu 24.04
- OS Version: 24.04.5 LTS
- Kernel Version: 7.0.0-1017-azure
- Image Version: 20261026.354.1
- Systemd version: 255.4-1ubuntu8.18

## Installed Software

### Language and Runtime
- Bash 5.2.21(1)-release
- Clang: 16.0.6, 17.0.6, 18.1.3
- Clang-format: 16.0.6, 17.0.6, 18.1.3
- Clang-tidy: 16.0.6, 17.0.6, 18.1.3
- Dash 0.5.12-6ubuntu5
- GNU C++: 12.4.0, 13.3.0, 14.2.0
- GNU Fortran: 12.4.0, 13.3.0, 14.2.0
- Julia 1.13.2
- Kotlin 2.4.21
- Node.js 22.23.4
- Perl 5.38.2
- Python 3.12.3
- Ruby 3.2.3
- Swift 6.4.1

### Package Management
- cpan 1.64
- Helm 3.22.1
- Homebrew 7.0.10
- Miniconda 26.9.4
- Npm 10.9.9
- Pip 24.0
- Pip3 24.0
- Pipx 1.16.7
- RubyGems 3.4.20
- Vcpkg (build from commit 817892b0ec)
- Yarn 1.22.22

#### Environment variables
| Name                    | Value                  |
| ----------------------- | ---------------------- |
| CONDA                   | /usr/share/miniconda   |
| VCPKG_INSTALLATION_ROOT | /usr/local/share/vcpkg |

#### Homebrew note
```
Location: /home/linuxbrew
Note: Homebrew is pre-installed on image but not added to PATH.
run the eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" command
to accomplish this.
```

### Project Management
- Ant 1.10.14
- Gradle 9.8.2
- Lerna 10.1.1
- Maven 3.10.0

### Tools
- Ansible 2.21.5
- AzCopy 10.34.1 - available by `azcopy` and `azcopy10` aliases
- Bazel 9.3.1
- Bazelisk 1.28.1
- Bicep 0.48.1
- Buildah 1.33.7
- CMake 3.31.6
- CodeQL Action Bundle 2.27.3
- Docker Amazon ECR Credential Helper 0.12.0
- Docker Compose 2.38.2
- Docker-Buildx 0.38.1
- Docker Client 28.0.4
- Docker Server 28.0.4
- Fastlane 2.241.1
- Git 2.56.0
- Git LFS 3.8.1
- Git-ftp 1.6.0
- Haveged 1.9.14
- jq 1.7
- Kind 0.33.0
- Kubectl 1.37.1
- Kustomize 5.8.3
- MediaInfo 24.01
- Mercurial 6.7.2
- Minikube 1.39.0
- n 11.0.0
- Newman 6.2.3
- nvm 0.40.8
- OpenSSL 3.0.13-0ubuntu3.16
- Packer 1.16.2
- Parcel 2.16.4
- Podman 4.9.3
- Pulumi 3.272.0
- Skopeo 1.13.3
- Sphinx Open Source Search Server 2.2.11
- yamllint 1.38.0
- yq 4.54.1
- zstd 1.5.7
- Ninja 1.13.2

### CLI Tools
- AWS CLI 2.38.5
- AWS CLI Session Manager Plugin 1.2.896.0
- AWS SAM CLI 1.170.0
- Azure CLI 2.91.0
- Azure CLI (azure-devops) 1.0.10
- GitHub CLI 2.103.2
- Google Cloud CLI 590.0.1

### Java
| Version             | Environment Variable |
| ------------------- | -------------------- |
| 8.0.504+1           | JAVA_HOME_8_X64      |
| 11.0.32+1           | JAVA_HOME_11_X64     |
| 17.0.21+9 (default) | JAVA_HOME_17_X64     |
| 21.0.13+9           | JAVA_HOME_21_X64     |
| 25.0.5+8            | JAVA_HOME_25_X64     |

### PHP Tools
- PHP: 8.3.6
- Composer 2.10.3
- PHPUnit 8.5.56
```
Both Xdebug and PCOV extensions are installed, but only Xdebug is enabled.
```

### Haskell Tools
- Cabal 3.18.2.0
- GHC 9.14.1
- GHCup 0.2.6.2
- Stack 3.11.1

### Rust Tools
- Cargo 1.99.1
- Rust 1.99.1
- Rustdoc 1.99.1
- Rustup 1.29.2

#### Packages
- Rustfmt 1.10.0

### Browsers and Drivers
- Google Chrome 156.0.8078.47
- ChromeDriver 156.0.8078.47
- Chromium 156.0.8078.0
- Microsoft Edge 156.0.4314.42
- Microsoft Edge WebDriver 156.0.4314.42
- Selenium server 4.51.0
- Mozilla Firefox 158.0.1
- Geckodriver 0.37.1

#### Environment variables
| Name              | Value                                 |
| ----------------- | ------------------------------------- |
| CHROMEWEBDRIVER   | /usr/local/share/chromedriver-linux64 |
| EDGEWEBDRIVER     | /usr/local/share/edge_driver          |
| GECKOWEBDRIVER    | /usr/local/share/gecko_driver         |
| SELENIUM_JAR_PATH | /usr/share/java/selenium-server.jar   |

### .NET Tools
- .NET Core SDK: 8.0.133, 8.0.206, 8.0.319, 8.0.427, 9.0.123, 9.0.205, 9.0.320, 10.0.114, 10.0.204, 10.0.303, 10.0.403
- nbgv 3.10.94+dea9a6c17c

### Databases
- sqlite3 3.45.1

#### PostgreSQL
- PostgreSQL 16.15
```
User: postgres
PostgreSQL service is disabled by default.
Use the following command as a part of your job to start the service: 'sudo systemctl start postgresql.service'
```

#### MySQL
- MySQL 8.0.46-0ubuntu0.24.04.4
```
User: root
Password: root
MySQL service is disabled by default.
Use the following command as a part of your job to start the service: 'sudo systemctl start mysql.service'
```

### Cached Tools

#### Go
- 1.24.13
- 1.25.14
- 1.26.10

#### Node.js
- 22.23.4
- 24.22.1

#### Python
- 3.11.17
- 3.12.15
- 3.13.17
- 3.14.9
- 3.15.1

#### PyPy
- 3.9.19 [PyPy 7.3.16]
- 3.10.16 [PyPy 7.3.19]
- 3.11.17 [PyPy 8.0.1]

#### Ruby
- 3.2.11
- 3.3.13
- 3.4.12
- 4.0.9

### PowerShell Tools
- PowerShell 7.6.9

#### PowerShell Modules
- Az: 15.6.1
- Microsoft.Graph: 2.41.2
- Pester: 5.9.0
- PSScriptAnalyzer: 1.25.0

### Web Servers
| Name    | Version | ConfigFile                | ServiceStatus | ListenPort |
| ------- | ------- | ------------------------- | ------------- | ---------- |
| apache2 | 2.4.58  | /etc/apache2/apache2.conf | inactive      | 80         |
| nginx   | 1.24.0  | /etc/nginx/nginx.conf     | inactive      | 80         |

### Android
| Package Name               | Version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android Command Line Tools | 12.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Android SDK Build-tools    | 37.0.0<br>36.0.0 36.1.0<br>35.0.0 35.0.1<br>34.0.0                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Android SDK Platform-Tools | 37.0.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Android SDK Platforms      | android-37.2-beta3 (rev 3)<br>android-37.2-beta2 (rev 2)<br>android-37.2-beta1 (rev 1)<br>android-37.2 (rev 1)<br>android-37.1 (rev 1)<br>android-37.0 (rev 2)<br>android-36.1 (rev 1)<br>android-36-ext19 (rev 1)<br>android-36-ext18 (rev 1)<br>android-36 (rev 2)<br>android-35-ext15 (rev 1)<br>android-35-ext14 (rev 1)<br>android-35 (rev 2)<br>android-34-ext8 (rev 1)<br>android-34-ext12 (rev 1)<br>android-34-ext11 (rev 1)<br>android-34-ext10 (rev 1)<br>android-34 (rev 3) |
| Android Support Repository | 47.0.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| CMake                      | 3.31.5<br>4.1.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Google Play services       | 49                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Google Repository          | 58                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| NDK                        | 27.3.13750724 (default)<br>29.0.14206865<br>30.0.16248370                                                                                                                                                                                                                                                                                                                                                                                                                               |

#### Environment variables
| Name                    | Value                                        |
| ----------------------- | -------------------------------------------- |
| ANDROID_HOME            | /usr/local/lib/android/sdk                   |
| ANDROID_NDK             | /usr/local/lib/android/sdk/ndk/27.3.13750724 |
| ANDROID_NDK_HOME        | /usr/local/lib/android/sdk/ndk/27.3.13750724 |
| ANDROID_NDK_LATEST_HOME | /usr/local/lib/android/sdk/ndk/30.0.16248370 |
| ANDROID_NDK_ROOT        | /usr/local/lib/android/sdk/ndk/27.3.13750724 |
| ANDROID_SDK_ROOT        | /usr/local/lib/android/sdk                   |

### Installed apt packages
| Name                   | Version                       |
| ---------------------- | ----------------------------- |
| acl                    | 2.3.2-1build1.1               |
| aria2                  | 1.37.0+debian-1build3         |
| autoconf               | 2.71-3                        |
| automake               | 1:1.16.5-1.3ubuntu1           |
| binutils               | 2.42-4ubuntu2.10              |
| bison                  | 2:3.8.2+dfsg-1ubuntu0.24.04.1 |
| brotli                 | 1.1.0-2build2                 |
| bzip2                  | 1.0.8-5.1ubuntu0.1            |
| coreutils              | 9.4-3ubuntu6.3                |
| curl                   | 8.5.0-2ubuntu10.16            |
| dbus                   | 1.14.10-4ubuntu4.1            |
| dnsutils               | 1:9.18.39-0ubuntu0.24.04.8    |
| dpkg                   | 1.22.6ubuntu6.6               |
| dpkg-dev               | 1.22.6ubuntu6.6               |
| fakeroot               | 1.33-1                        |
| file                   | 1:5.45-3build1                |
| findutils              | 4.9.0-5build1                 |
| flex                   | 2.6.4-8.2build1               |
| fonts-noto-color-emoji | 2.047-0ubuntu0.24.04.1        |
| ftp                    | 20230507-2build3              |
| g++                    | 4:13.2.0-7ubuntu1             |
| gcc                    | 4:13.2.0-7ubuntu1             |
| gnupg2                 | 2.4.4-2ubuntu17.6             |
| haveged                | 1.9.14-1ubuntu2               |
| iproute2               | 6.1.0-1ubuntu6.4              |
| iputils-ping           | 3:20240117-1ubuntu0.1         |
| jq                     | 1.7.1-3ubuntu0.24.04.2        |
| libicu-dev             | 74.2-1ubuntu3.1               |
| libnss3-tools          | 2:3.98-1ubuntu0.3             |
| libsqlite3-dev         | 3.45.1-1ubuntu2.8             |
| libssl-dev             | 3.0.13-0ubuntu3.16            |
| libtool                | 2.4.7-7build1                 |
| libyaml-dev            | 0.2.5-1build1                 |
| locales                | 2.39-0ubuntu8.9               |
| lz4                    | 1.9.4-1build1.1               |
| m4                     | 1.4.19-4build1                |
| make                   | 4.3-4.1build2                 |
| mediainfo              | 24.01.1-1build2               |
| mercurial              | 6.7.2-1ubuntu2.2              |
| net-tools              | 2.10-0.1ubuntu4.4             |
| netcat                 | 1.226-1ubuntu2                |
| openssh-client         | 1:9.6p1-3ubuntu13.20          |
| p7zip-full             | 16.02+transitional.1          |
| p7zip-rar              | 16.02+transitional.1          |
| parallel               | 20231122+ds-1                 |
| patchelf               | 0.18.0-1.1build1              |
| pigz                   | 2.8-1                         |
| pkg-config             | 1.8.1-2build1                 |
| pollinate              | 4.33-3.1ubuntu1.3             |
| python-is-python3      | 3.11.4-1                      |
| rpm                    | 4.18.2+dfsg-2.1build2         |
| rsync                  | 3.2.7-1ubuntu1.5              |
| shellcheck             | 0.9.0-1                       |
| sphinxsearch           | 2.2.11-8build1                |
| sqlite3                | 3.45.1-1ubuntu2.8             |
| ssh                    | 1:9.6p1-3ubuntu13.20          |
| sshpass                | 1.09-1                        |
| sudo                   | 1.9.15p5-3ubuntu5.24.04.4     |
| swig                   | 4.2.0-2ubuntu1                |
| systemd-coredump       | 255.4-1ubuntu8.18             |
| tar                    | 1.35+dfsg-3ubuntu0.4          |
| telnet                 | 0.17+2.5-3ubuntu4.2           |
| texinfo                | 7.1-3build2                   |
| time                   | 1.9-0.2build1                 |
| tk                     | 8.6.14build1                  |
| tree                   | 2.1.1-2ubuntu3.24.04.2        |
| tzdata                 | 2026e-0ubuntu0.24.04.1        |
| unzip                  | 6.0-28ubuntu4.1               |
| upx                    | 4.2.2-3                       |
| wget                   | 1.21.4-1ubuntu4.5             |
| xvfb                   | 2:21.1.12-1ubuntu1.9          |
| xz-utils               | 5.6.1+really5.4.5-1ubuntu0.4  |
| zip                    | 3.0-13ubuntu0.2               |
| zsync                  | 0.6.2-5build1                 |

