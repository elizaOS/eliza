pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // XREAL SDK — add the local AAR via flatDir after downloading from developer.xreal.com
        flatDir {
            dirs("app/libs")
        }
    }
}

rootProject.name = "ElizaFacewearXreal"
include(":app")
