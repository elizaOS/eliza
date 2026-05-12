require 'json'
require 'pathname'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
framework_path = ENV['ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK']
framework_path = File.expand_path('artifacts/ElizaBunEngine.xcframework', __dir__) if framework_path.nil? || framework_path.empty?
framework_path = File.expand_path(framework_path, __dir__)

unless File.exist?(framework_path)
  raise "ELIZA_IOS_FULL_BUN_ENGINE requested but ElizaBunEngine.xcframework was not found at #{framework_path}"
end

framework_relpath = Pathname.new(framework_path).relative_path_from(Pathname.new(__dir__)).to_s
if framework_relpath.start_with?('..')
  raise "ElizaBunEngine.xcframework must be staged inside #{__dir__}; got #{framework_path}"
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
  s.vendored_frameworks = framework_relpath
  s.frameworks = 'Foundation', 'JavaScriptCore', 'Network', 'Security', 'SystemConfiguration'
  s.pod_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) -ObjC'
  }
end
