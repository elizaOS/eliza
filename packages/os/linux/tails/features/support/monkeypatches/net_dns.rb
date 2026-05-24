# rubocop:disable Style/Documentation

# The version of Net::DNS (Debian package: ruby-net-dns) in Debian
# Trixie is too old and lacks support for DNS queries with type HTTPS,
# which can be emitted by the Unsafe Browser leading to parse failures
# in the firewall leak detector.

if Net::DNS::RR::Types::TYPES['HTTPS'].nil?
  class Net::DNS::RR::Types
    orig_types = Net::DNS::RR::Types::TYPES.dup
    # If we directly redefine TYPES we'll get the annoying "already
    # initialized constant" warning.
    remove_const(:TYPES)
    TYPES = orig_types
    # RFC 9460, section 14.2
    TYPES['HTTPS'] = 65
    TYPES.freeze
    public_constant :TYPES
  end
else
  warn 'It seems your version of Net::DNS supports parsing type HTTPS ' \
       "DNS queries; please file an issue about removing #{__FILE__}"
end

assert_equal(65, Net::DNS::RR::Types::TYPES['HTTPS'])

# rubocop:enable Style/Documentation
