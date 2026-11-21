# Ativar contas online no Sonora

O site é hospedado pelo GitHub Pages, que serve arquivos estáticos. Para ter contas reais, fotos e músicas públicas, o Sonora usa Supabase Auth, Database e Storage.

## 1. Criar o backend

1. Crie um projeto no Supabase.
2. Abra **SQL Editor** no painel do projeto.
3. Execute todo o arquivo `supabase/schema.sql`.
4. Em **Authentication → URL Configuration**, configure o Site URL como `https://kauan999456p.github.io/Sonora/` e adicione esse endereço aos Redirect URLs.

## 2. Ligar o site ao Supabase

1. No painel do Supabase, abra **Project Settings → API**.
2. Copie o **Project URL** e a chave pública **Publishable key** (ou a chave antiga `anon`).
3. Abra `backend-config.js` neste repositório e preencha `supabaseUrl` e `supabaseAnonKey`.
4. Salve no branch `main`. O GitHub Pages publicará a alteração.

**Não coloque uma chave `service_role` ou `Secret key` no site.** A chave que fica no navegador deve ser a Publishable/anon. As políticas RLS no SQL controlam as permissões.

## 3. Confirmação do e-mail

Em **Authentication → Providers → Email**, deixe a confirmação de e-mail ativada. O cadastro pode solicitar que a pessoa confirme a caixa de entrada antes do primeiro login.

## Recursos incluídos

- Cadastro e login com e-mail e senha.
- Sessão mantida no navegador; a pessoa pode entrar com a mesma conta em outros dispositivos.
- Perfil com foto, nome de exibição, @usuário e bio.
- Comunidade com feed de músicas publicadas.
- Upload de áudio até 25 MB e capa até 3 MB.
- Remover as próprias faixas e denunciar publicações de outras pessoas.

## Cuidados

- Publique somente áudio original seu ou conteúdo para o qual tenha autorização.
- O bucket de mídia é público para permitir reprodução sem login. Não envie documentos nem arquivos privados.
- Fotos de perfil aceitam JPG, PNG e WebP até 2 MB.
- O cadastro online fica inativo até configurar as credenciais públicas do Supabase em `backend-config.js`.
