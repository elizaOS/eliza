require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
include_llama = %w[1 true yes on].include?(ENV.fetch('ELIZA_IOS_INCLUDE_LLAMA', '').downcase)
include_full_bun_engine = %w[1 true yes on].include?(ENV.fetch('ELIZA_IOS_FULL_BUN_ENGINE', '').downcase)
full_bun_frameworks = ['Network', 'Accelerate', 'Metal', 'MetalKit', 'MetalPerformanceShaders', 'Foundation', 'CoreML', 'NaturalLanguage']
compat_frameworks = ['JavaScriptCore', *full_bun_frameworks]
frameworks = include_full_bun_engine ? full_bun_frameworks : compat_frameworks
swift_flags = '$(inherited)'
swift_flags += ' -D ELIZA_IOS_INCLUDE_LLAMA' if include_llama
swift_flags += ' -D ELIZA_IOS_FULL_BUN_ENGINE' if include_full_bun_engine
other_ldflags = '$(inherited) -ObjC'
other_ldflags += ' -l"llama"' if include_llama
library_search_paths = '$(inherited)'
library_search_paths += ' "${PODS_XCFRAMEWORKS_BUILD_DIR}/LlamaCpp"' if include_llama
source_files = if include_full_bun_engine
  [
    'ios/Sources/ElizaBunRuntimePlugin/ElizaBunRuntimePlugin.swift',
    'ios/Sources/ElizaBunRuntimePlugin/ElizaBunRuntime.swift',
    'ios/Sources/ElizaBunRuntimePlugin/FullBunEngineHost.swift',
    'ios/Sources/ElizaBunRuntimePlugin/SandboxPaths.swift',
    'ios/Sources/ElizaBunRuntimePlugin/bridge/KeepAwakeBridge.swift',
    'ios/Sources/ElizaBunRuntimePlugin/bridge/LlamaBridgeImpl.swift',
    'ios/Sources/ElizaBunRuntimePlugin/kokoro/**/*.swift'
  ]
else
  'ios/Sources/**/*.{swift,m,mm,h}'
end

Pod::Spec.new do |s|
  s.name = 'ElizaosCapacitorBunRuntime'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license'] || { :type => 'MIT' }
  s.homepage = 'https://github.com/elizaOS'
  s.authors = { 'elizaOS' => 'shaw@elizalabs.ai' }
  s.source = { :git => 'https://github.com/elizaOS/eliza.git', :tag => s.version.to_s }
  s.source_files = source_files
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.dependency 'LlamaCpp' if include_llama
  s.dependency 'LlamaCppCapacitor' if include_llama
  s.dependency 'ElizaBunEngine' if include_full_bun_engine
  s.frameworks = frameworks
  s.libraries = 'c++', 'c++abi'
  s.swift_version = '5.9'

  s.pod_target_xcconfig = {
    'OTHER_LDFLAGS' => other_ldflags,
    'OTHER_SWIFT_FLAGS' => swift_flags,
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'LIBRARY_SEARCH_PATHS' => library_search_paths
  }
end
