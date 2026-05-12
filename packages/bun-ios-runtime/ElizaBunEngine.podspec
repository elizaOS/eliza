require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
framework_path = ENV['ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK']
framework_path = File.expand_path('artifacts/ElizaBunEngine.xcframework', __dir__) if framework_path.nil? || framework_path.empty?

unless File.exist?(framework_path)
  raise "ELIZA_IOS_FULL_BUN_ENGINE requested but ElizaBunEngine.xcframework was not found at #{framework_path}"
end

Pod::Spec.new do |s|
  s.name = 'ElizaBunEngine'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license'] || { :type => 'MIT' }
  s.homepage = 'https://github.com/elizaOS'
  s.authors = { 'elizaOS' => 'shaw@elizalabs.ai' }
  s.source = { :git => 'https://github.com/elizaOS/eliza.git', :tag => s.version.to_s }
  s.ios.deployment_target = '15.0'
  s.vendored_frameworks = framework_path
  s.frameworks = 'Foundation', 'JavaScriptCore', 'Network', 'Security', 'SystemConfiguration'
  s.pod_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) -ObjC'
  }
end
