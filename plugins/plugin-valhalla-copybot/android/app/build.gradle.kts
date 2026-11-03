plugins {
    id("com.android.application")
}

android {
    namespace = "ai.tokenjunction.valhalla"
    compileSdk = 34

    defaultConfig {
        applicationId = "ai.tokenjunction.valhalla"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-test"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("com.google.android.gms:play-services-ads:23.6.0")
}
