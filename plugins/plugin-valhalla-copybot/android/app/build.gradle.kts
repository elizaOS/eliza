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
    compileSdk = 34

    defaultConfig {
        applicationId = "ai.tokenjunction.valhalla"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-test"
        manifestPlaceholders["admobAppId"] = admobAppId
        buildConfigField("boolean", "ADS_ENABLED", adsEnabled.toString())
        buildConfigField("String", "ADMOB_APP_ID", quote(admobAppId))
        buildConfigField("String", "ADMOB_BANNER_ID", quote(admobBannerId))
        buildConfigField("String", "ADMOB_INTERSTITIAL_ID", quote(admobInterstitialId))
        buildConfigField("String", "ADMOB_REWARDED_ID", quote(admobRewardedId))
        buildConfigField("String", "HOUSE_ADS_URL", quote(houseAdsUrl))
        buildConfigField("String", "PRIVACY_POLICY_URL", quote(privacyPolicyUrl))
    }

    buildFeatures {
        buildConfig = true
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
    implementation("com.google.android.ump:user-messaging-platform:3.1.0")
}
