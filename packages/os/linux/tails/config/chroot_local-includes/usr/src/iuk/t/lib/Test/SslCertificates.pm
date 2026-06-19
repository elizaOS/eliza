package Test::SslCertificates;

use 5.10.1;
use strictures 2;
use autodie qw(:all);

use Exporter;
our @ISA = qw{Exporter};
our @EXPORT = qw{generate_ssl_privkey generate_self_signed_ssl_cert generate_ssl_req generate_ssl_cert populate_ssl_template};

use Carp::Assert;
use Function::Parameters;
use Path::Tiny;
use Test::More;

fun generate_ssl_privkey ($args) {
    assert(defined $args,     'args is defined');
    assert('HASH' eq ref $args, 'args is a hashref');
    assert(exists  $args->{outfile}, "args has a outfile key");
    assert(defined $args->{outfile}, "the outfile key in args is defined");
    assert(length  $args->{outfile}, "the outfile key in args is not empty");

    my $cmd = "certtool --generate-privkey ".
        "--outfile '$args->{outfile}' ".
        "2>&1 >/dev/null";
    `$cmd`;
    ok(-e $args->{outfile});
}

fun generate_ssl_req ($args) {
    assert(defined $args,       'args is defined');
    assert('HASH' eq ref $args, 'args is a hashref');
    for (qw{outfile privkey template}) {
        assert(exists  $args->{$_}, "args has a $_ key");
        assert(defined $args->{$_}, "the $_ key in args is defined");
        assert(length  $args->{$_}, "the $_ key in args is not empty");
    }
    for (qw{privkey template}) {
        assert(-e $args->{$_}, "$_ file exists");
    }

    my $cmd = sprintf(
        "certtool --generate-request --load-privkey '%s' " .
        "--outfile '%s' --template '%s' 2>&1 >/dev/null",
        $args->{privkey}, $args->{outfile}, $args->{template},
    );
    `$cmd`;
    ok(-e $args->{outfile});
}

fun generate_self_signed_ssl_cert ($args) {
    assert(defined $args,     'args is defined');
    assert('HASH' eq ref $args, 'args is a hashref');
    for (qw{outfile privkey template}) {
        assert(exists  $args->{$_}, "args has a $_ key");
        assert(defined $args->{$_}, "the $_ key in args is defined");
        assert(length  $args->{$_}, "the $_ key in args is not empty");
    }
    for (qw{privkey template}) {
        assert(-e $args->{$_}, "$_ file exists");
    }

    my $cmd =
        "certtool --generate-self-signed --load-privkey '$args->{privkey}' ".
        "--template '$args->{template}' --outfile '$args->{outfile}' ".
        "2>&1 >/dev/null";
    `$cmd`;
    ok(-e $args->{outfile});
}

fun generate_ssl_cert ($args) {
    assert(defined $args,     'args is defined');
    assert('HASH' eq ref $args, 'args is a hashref');
    for (qw{req outfile ca_cert ca_privkey template}) {
        assert(exists  $args->{$_}, "args has a $_ key");
        assert(defined $args->{$_}, "the $_ key in args is defined");
        assert(length  $args->{$_}, "the $_ key in args is not empty");
    }
    for (qw{ca_privkey ca_cert req template}) {
        assert(-e $args->{$_}, "$_ file exists");
    }

    my $precmd = exists $args->{date} && defined $args->{date}
        ? sprintf("faketime '%s'", $args->{date})
        : '';

    my $cmd = sprintf(
        "$precmd certtool --generate-certificate --load-ca-privkey '%s' ".
        "--load-ca-certificate '%s' --load-request '%s' --outfile '%s' ".
        "--template '%s' 2>&1 >/dev/null",
        $args->{ca_privkey}, $args->{ca_cert}, $args->{req}, $args->{outfile},
        $args->{template},
    );
    `$cmd`;
    ok(-e $args->{outfile});
}

fun populate_ssl_template ($args) {
    assert(defined $args,     'args is defined');
    assert('HASH' eq ref $args, 'args is a hashref');
    assert(exists  $args->{outfile}, "args has a outfile key");
    assert(defined $args->{outfile}, "the outfile key in args is defined");
    assert(length  $args->{outfile}, "the outfile key in args is not empty");

    $args->{ca} //= 0;

    my $fh = path($args->{outfile})->openw;
    say $fh <<EOTEMPLATE
organization = "Koko inc."
unit = "sleeping dept."
state = "Attiki"
country = GR
cn = "127.0.0.1"
# Set domain components
#dc = "name"
#dc = "domain"
serial = 007
expiration_days = 365

# A dnsname in case of a WWW server.
#dns_name = "www.none.org"
#dns_name = "www.morethanone.org"

# A subject alternative name URI
#uri = "http://www.example.com"

# An IP address in case of a server.
ip_address = "127.0.0.1"

# Challenge password used in certificate requests
#challenge_passwd = 123456

# Whether this certificate will be used for a TLS server
tls_www_server

# Whether this certificate will be used to sign data (needed
# in TLS DHE ciphersuites).
signing_key

# Whether this certificate will be used to encrypt data (needed
# in TLS RSA ciphersuites). Note that it is preferred to use different
# keys for encryption and signing.
#encryption_key
EOTEMPLATE
;

    if ($args->{ca}) {
        say $fh <<EOCASNIPPET
# Whether this is a CA certificate or not
ca
# Whether this key will be used to sign other certificates.
cert_signing_key
EOCASNIPPET
;
    }

    close $fh;
    ok(-e $args->{outfile});
}

1;
