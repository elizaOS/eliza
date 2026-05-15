require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
include_llama = %w[1 true yes on].include?(ENV.fetch('ELIZA_IOS_INCLUDE_LLAMA', '').downcase)
include_full_bun_engine = %w[1 true yes on].include?(ENV.fetch('ELIZA_IOS_FULL_BUN_ENGINE', '').downcase)
include_sqlite_vec = %w[1 true yes on].include?(ENV.fetch('ELIZA_IOS_INCLUDE_SQLITE_VEC', '').downcase)
frameworks = ['JavaScriptCore', 'Network', 'Accelerate', 'Metal', 'MetalKit', 'MetalPerformanceShaders', 'Foundation']
frameworks << 'LlamaCpp' if include_llama
swift_flags = '$(inherited)'
swift_flags += ' -D ELIZA_IOS_INCLUDE_LLAMA' if include_llama
swift_flags += ' -D ELIZA_IOS_FULL_BUN_ENGINE' if include_full_bun_engine
swift_flags += ' -D ELIZA_IOS_INCLUDE_SQLITE_VEC' if include_sqlite_vec

Pod::Spec.new do |s|
  s.name = 'ElizaosCapacitorBunRuntime'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license'] || { :type => 'MIT' }
  s.homepage = 'https://github.com/elizaOS'
  s.authors = { 'elizaOS' => 'shaw@elizalabs.ai' }
  s.source = { :git => 'https://github.com/elizaOS/eliza.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,m,mm,h}'
  s.ios.deployment_target = '16.0'
  s.dependency 'Capacitor'
  s.dependency 'LlamaCppCapacitor' if include_llama
  s.dependency 'ElizaBunEngine' if include_full_bun_engine
  s.frameworks = frameworks
  s.libraries = 'c++', 'c++abi'
  s.swift_version = '5.9'

  s.pod_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) -ObjC',
    'OTHER_SWIFT_FLAGS' => swift_flags,
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++'
  }
end
