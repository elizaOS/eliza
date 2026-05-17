package Test::WebServer::Static::SSL;

use strictures 2;
use Carp::Assert;

use parent qw{Test::WebServer::Static};

use IO::Socket::SSL;

sub accept_hook {
    my $self = shift;
    my $fh   = $self->stdio_handle;

    for (qw{cert key}) {
        assert(exists  $self->{$_});
        assert(defined $self->{$_});
    }

    $self->SUPER::accept_hook(@_);

    my $newfh = IO::Socket::SSL->start_SSL(
            $fh,
            SSL_server      => 1,
            SSL_cert_file   => $self->{cert},
            SSL_key_file    => $self->{key},
            SSL_ca_file     => $self->{cert},
            SSL_verify_mode => 0,
        );

    if ($newfh) {
        return $self->stdio_handle($newfh);
    }
    else {
        warn "problem setting up SSL socket: " . IO::Socket::SSL::errstr();
    }

    return;
}

1;
