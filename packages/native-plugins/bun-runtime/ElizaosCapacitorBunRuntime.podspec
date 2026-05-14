require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
include_llama = %w[1 true yes on].include?(ENV.fetch('ELIZA_IOS_INCLUDE_LLAMA', '').downcase)
app_store_local_runtime =
  %w[1 true yes on].include?(ENV.fetch('ELIZA_IOS_APP_STORE_LOCAL_RUNTIME', '').downcase) ||
  %w[1 true yes on].include?(ENV.fetch('ELIZA_IOS_APP_STORE_COMPLIANT_LOCAL_RUNTIME', '').downcase)
frameworks = ['JavaScriptCore', 'Network', 'Accelerate', 'Metal', 'MetalKit', 'MetalPerformanceShaders', 'Foundation']
frameworks << 'LlamaCpp' if include_llama
swift_flags = '$(inherited)'
swift_flags += ' -D ELIZA_IOS_INCLUDE_LLAMA' if include_llama
swift_flags += ' -D ELIZA_IOS_APP_STORE_COMPLIANT_LOCAL_RUNTIME' if app_store_local_runtime

Pod::Spec.new do |s|
  s.name = 'ElizaosCapacitorBunRuntime'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license'] || { :type => 'MIT' }
  s.homepage = 'https://github.com/elizaOS'
  s.authors = { 'elizaOS' => 'shaw@elizalabs.ai' }
  s.source = { :git => 'https://github.com/elizaOS/eliza.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,m,mm,h}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.dependency 'LlamaCppCapacitor' if include_llama
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
