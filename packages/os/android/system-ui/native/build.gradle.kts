plugins {
    id("com.android.library")
    kotlin("android")
}

android {
    namespace = "ai.elizaos.system.bridge"
    compileSdk = 35

    defaultConfig {
        minSdk = 31
        targetSdk = 35
        consumerProguardFiles("consumer-rules.pro")
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
    // IMPL: pull androidx.core + androidx.webkit when wiring lands.
    // implementation("androidx.core:core-ktx:1.13.1")
    // implementation("androidx.webkit:webkit:1.11.0")
}
