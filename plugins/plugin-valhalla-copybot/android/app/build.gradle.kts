import java.util.Properties

plugins {
    id("com.android.application")
}

// Google's published sample IDs. They never serve a paid ad.
// Replace them at build time with ADMOB_* from the environment or local.properties.
val sampleAppId = "ca-app-pub-3940256099942544~3347511713"
val sampleBannerId = "ca-app-pub-3940256099942544/6300978111"
val sampleInterstitialId = "ca-app-pub-3940256099942544/1033173712"
val sampleRewardedId = "ca-app-pub-3940256099942544/5224354917"

fun buildValue(name: String, fallback: String): String {
    val fromEnv = System.getenv(name)?.trim().orEmpty()
    if (fromEnv.isNotEmpty()) return fromEnv
    val local = rootProject.file("local.properties")
    if (local.exists()) {
        val props = Properties()
        local.inputStream().use { props.load(it) }
        val fromFile = props.getProperty(name)?.trim().orEmpty()
        if (fromFile.isNotEmpty()) return fromFile
    }
    return fallback
}

fun quote(value: String): String {
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}

val adsEnabled = buildValue("ADS_ENABLED", "true").equals("true", ignoreCase = true)
val admobAppId = buildValue("ADMOB_APP_ID", sampleAppId)
val admobBannerId = buildValue("ADMOB_BANNER_ID", sampleBannerId)
val admobInterstitialId = buildValue("ADMOB_INTERSTITIAL_ID", sampleInterstitialId)
val admobRewardedId = buildValue("ADMOB_REWARDED_ID", sampleRewardedId)
val houseAdsUrl = buildValue("HOUSE_ADS_URL", "")
val privacyPolicyUrl = buildValue("PRIVACY_POLICY_URL", "")

android {
    namespace = "ai.tokenjunction.valhalla"
    compileSdk = 36

    defaultConfig {
        applicationId = "ai.tokenjunction.valhalla"
        minSdk = 26
        targetSdk = 36
        versionCode = System.getenv("VERSION_CODE")?.toIntOrNull() ?: 1
        versionName = System.getenv("VERSION_NAME")?.trim().takeUnless { it.isNullOrEmpty() } ?: "0.1.0"
        manifestPlaceholders["admobAppId"] = admobAppId
        buildConfigField("boolean", "ADS_ENABLED", adsEnabled.toString())
        buildConfigField("String", "ADMOB_APP_ID", quote(admobAppId))
        buildConfigField("String", "ADMOB_BANNER_ID", quote(admobBannerId))
        buildConfigField("String", "ADMOB_INTERSTITIAL_ID", quote(admobInterstitialId))
        buildConfigField("String", "ADMOB_REWARDED_ID", quote(admobRewardedId))
        buildConfigField("String", "HOUSE_ADS_URL", quote(houseAdsUrl))
        buildConfigField("String", "PRIVACY_POLICY_URL", quote(privacyPolicyUrl))
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    val keystorePath = System.getenv("VALHALLA_KEYSTORE")?.trim().orEmpty()
    signingConfigs {
        if (keystorePath.isNotEmpty()) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("VALHALLA_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("VALHALLA_KEY_ALIAS")
                keyPassword = System.getenv("VALHALLA_KEY_PASSWORD")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (keystorePath.isNotEmpty()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    packaging {
        jniLibs {
            excludes += setOf("**/armeabi-v7a/**", "**/x86/**")
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
    implementation("com.google.android.ump:user-messaging-platform:3.1.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}

// Mediation adapters stay off until you enable one in the AdMob console.
// Add the adapter line from android/ad-mediation.json here when you turn it on.
// Do not add an adapter you have not configured. Extra SDKs collect more data.
