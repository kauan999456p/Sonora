# Sonora v1.0

**Sonora é um player musical online**, com catálogo, busca, reprodução integrada, playlists e recomendações. Esta versão é somente web: não inclui edição local, instalador Windows ou aplicativo desktop.

## Publicar no GitHub Pages

1. Abra **Settings → Pages** no repositório.
2. Em **Build and deployment**, selecione **Deploy from a branch**.
3. Escolha a branch `main` e a pasta `/(root)`.
4. Salve e aguarde a publicação. O arquivo `index.html` está na raiz; não é necessário compilar.

## Catálogo e reprodução

O catálogo usa a **API oficial do Audius** para mostrar músicas em alta, pesquisar faixas e transmitir áudio pelo endpoint oficial de streaming.

- As consultas de leitura funcionam, em sua maioria, sem credenciais; uma chave de API pode aumentar os limites de uso.
- O Sonora não baixa nem hospeda os áudios do catálogo. O streaming é feito diretamente pelo Audius.
- Cada faixa inclui um link para sua página original.
- A presença de uma música no catálogo não significa que ela seja domínio público ou que possa ser reutilizada em vídeos. Confira sempre as permissões do criador antes de reutilizar o áudio fora da plataforma.

Documentação: https://docs.audius.co/api/

## Recursos

- Catálogo online com faixas em alta e pesquisa.
- Categorias de descoberta.
- Player com play/pause, volume, faixa anterior/próxima, aleatório e repetição.
- Biblioteca opcional de arquivos escolhidos pelo usuário e importação por arrastar e soltar.
- Playlists, favoritas e histórico.
- Recomendações locais baseadas no histórico e nas favoritas.
- Login local do navegador com PBKDF2 e dados protegidos com AES-GCM.
- Tutorial interativo com Lumi.
- Creator Lab com rascunhos de Reels.

## Privacidade e limitações

O login é local ao navegador, não uma conta sincronizada entre dispositivos. Playlists, histórico, preferências e arquivos importados ficam no armazenamento do próprio navegador. O áudio online é transmitido pelo Audius, sem ser copiado para o GitHub.

É necessário internet para o catálogo e o streaming. A disponibilidade de músicas depende do Audius e algumas faixas podem deixar de estar disponíveis. O armazenamento local depende da cota do navegador. A senha local não pode ser recuperada se for esquecida.

## Licença

A licença do código está em `LICENSE`. Ela não concede direitos sobre músicas, capas ou outros materiais de terceiros disponibilizados pelo Audius.
