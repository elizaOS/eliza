require 'resolv'

When /^I (wget|curl) "([^"]+)" to stdout$/ do |cmd, url|
  retry_tor do
    arguments = if cmd == 'wget'
                  "-O - '#{url}'"
                else
                  "-s '#{url}'"
                end
    @vm_execute_res = $vm.execute("#{cmd} #{arguments}", user: LIVE_USER)
    if @vm_execute_res.failure?
      raise "#{cmd}:ing #{url} failed with:\n" \
            "#{@vm_execute_res.stdout}\n" +
            @vm_execute_res.stderr.to_s
    end
  end
end

Then /^the (wget|curl) command is successful$/ do |cmd|
  assert(
    @vm_execute_res.success?,
    "#{cmd} failed:\n" \
    "#{@vm_execute_res.stdout}\n" +
    @vm_execute_res.stderr.to_s
  )
end

Then /^the (wget|curl) standard output contains "([^"]+)"$/ do |cmd, text|
  assert(
    @vm_execute_res.stdout[text],
    "The #{cmd} standard output does not contain #{text}:\n" \
    "#{@vm_execute_res.stdout}\n" +
    @vm_execute_res.stderr.to_s
  )
end
