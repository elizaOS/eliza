// Installable privileged system app. Ships in /system/priv-app/ signed with
// the platform key so the signature-level controls in SystemBridge.kt
// (REBOOT, DEVICE_POWER, WRITE_SECURE_SETTINGS) resolve through the
// privapp allowlist `privapp-permissions-ai.elizaos.system.bridge.xml`.
plugins {
    id("com.android.application")
    kotlin("android")
}

android {
    namespace = "ai.elizaos.system.bridge"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.elizaos.system.bridge"
        minSdk = 31
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
}
