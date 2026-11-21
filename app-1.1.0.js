'use strict';

const DB_NAME = 'sonora-online-v1';
const DB_VERSION = 2;
const MAX_REEL_VIDEO_BYTES = 1_000_000_000; // 1 GB decimal
const REEL_VIDEO_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MiB per encrypted block
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const state = {
  user: null, key: null, localTracks: [], onlineTracks: [], savedOnline: [], playlists: [], favorites: [], history: [],
  current: null, currentObjectUrl: null, reelPreviewUrl: null, queue: [], queueIndex: -1,
  libraryFilter: 'all', repeat: false, shuffle: false, activePlaylist: null,
  tutorialStep: 0, tutorialSteps: [], reelsDrafts: [], reelsInitialized: false, reelFilter: 'all', reelSearch: '', reelsVisible: 20,
  communityTracks: [], cloudUser: null, cloudProfile: null, supabaseClient: null, authMode: 'signup',
};
const audio = $('#audio-element');

// A edição local já está no computador: não exibe o convite para baixar a si mesma.
if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  const localBanner = $('#local-edition-banner');
  if (localBanner) localBanner.remove();
}

let dbConnectionPromise = null;
function dbOpen() {
  if (!('indexedDB' in window)) {
    return Promise.reject(new Error('Este navegador está bloqueando o armazenamento local do Sonora.'));
  }
  if (dbConnectionPromise) return dbConnectionPromise;
  dbConnectionPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath:'id'});
      if (!db.objectStoreNames.contains('vault')) db.createObjectStore('vault', {keyPath:'id'});
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', {keyPath:'id'});
    };
    request.onblocked = () => {
      dbConnectionPromise = null;
      reject(new Error('O armazenamento está ocupado por outra aba. Feche outras abas do Sonora e tente novamente.'));
    };
    request.onerror = () => {
      dbConnectionPromise = null;
      reject(request.error || new Error('Não foi possível abrir o armazenamento do Sonora.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbConnectionPromise = null;
      };
      resolve(db);
    };
  });
  return dbConnectionPromise;
}
async function dbGet(store, id) { const db=await dbOpen(); return new Promise((resolve,reject)=>{const r=db.transaction(store,'readonly').objectStore(store).get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}); }
async function dbPut(store, value) { const db=await dbOpen(); return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);}); }
async function dbAll(store) { const db=await dbOpen(); return new Promise((resolve,reject)=>{const r=db.transaction(store,'readonly').objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}); }
async function dbClear(store) { const db=await dbOpen(); return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).clear();tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);}); }
async function dbDelete(store,id){const db=await dbOpen();return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
async function dbDeletePrefix(store,prefix,keepPrefix=''){const rows=await dbAll(store);const ids=rows.filter(row=>String(row.id).startsWith(prefix)&&(!keepPrefix||!String(row.id).startsWith(keepPrefix))).map(row=>row.id);if(!ids.length)return;const db=await dbOpen();await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite'),os=tx.objectStore(store);ids.forEach(id=>os.delete(id));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}

const enc = new TextEncoder(), dec = new TextDecoder();
function toB64(bytes) { let s=''; for(let i=0;i<bytes.length;i+=0x8000) s+=String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(s); }
function fromB64(value) { const s=atob(value); const out=new Uint8Array(s.length); for(let i=0;i<s.length;i++)out[i]=s.charCodeAt(i); return out; }
async function deriveKey(password, salt) { const base=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']); return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:310000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']); }
async function encryptText(text,key) { const iv=crypto.getRandomValues(new Uint8Array(12)); const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(text)); return {iv:toB64(iv),data:toB64(new Uint8Array(encrypted))}; }
async function decryptText(item,key) { const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(item.iv)},key,fromB64(item.data)); return dec.decode(clear); }
async function saveVault() {
  if(!state.key) return;
  const payload={user:state.user,playlists:state.playlists,favorites:state.favorites,history:state.history,savedOnline:state.savedOnline,reelsDrafts:state.reelsDrafts,reelsInitialized:state.reelsInitialized};
  await dbPut('vault',{id:'app-state',...(await encryptText(JSON.stringify(payload),state.key))});
}
async function saveTrack(track) {
  if(!state.key) return; // modo visitante: não tenta usar o cofre criptografado
  const raw=await track.file.arrayBuffer();
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const payload=JSON.stringify({meta:{...track,file:undefined,blobUrl:undefined},audio:toB64(new Uint8Array(raw))});
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},state.key,enc.encode(payload));
  await dbPut('vault',{id:`track:${track.id}`,iv:toB64(iv),data:toB64(new Uint8Array(encrypted))});
}
async function loadVault() {
  const vault=await dbAll('vault');
  const app=vault.find(x=>x.id==='app-state');
  if(app){ const data=JSON.parse(await decryptText(app,state.key)); state.user=data.user;state.playlists=data.playlists||[];state.favorites=data.favorites||[];state.history=data.history||[];state.savedOnline=data.savedOnline||[];state.reelsDrafts=data.reelsDrafts||[];state.reelsInitialized=data.reelsInitialized===true; }
  state.localTracks=[];
  for(const item of vault.filter(x=>x.id.startsWith('track:'))){
    try { const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(item.iv)},state.key,fromB64(item.data)); const payload=JSON.parse(dec.decode(clear)); const bytes=fromB64(payload.audio); const mime=payload.meta.mime||'audio/mpeg'; const file=new File([bytes],payload.meta.fileName||'audio', {type:mime}); state.localTracks.push({...payload.meta,file}); }
    catch(e){ console.warn('Faixa protegida não pôde ser aberta.',e); }
  }
}

function showToast(message,type='success') { const el=document.createElement('div');el.className=`toast ${type}`;el.textContent=message;$('#toast-region').append(el);setTimeout(()=>el.remove(),3400); }
function formatTime(seconds) { if(!Number.isFinite(seconds)||seconds<0)return '0:00'; const m=Math.floor(seconds/60),s=Math.floor(seconds%60);return `${m}:${String(s).padStart(2,'0')}`; }
function safeText(value='') { return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const palettes=[['#544782','#bd80a8'],['#285b68','#7ac8bd'],['#4d426f','#9c85d9'],['#804a67','#e19b9b'],['#315b78','#8b9ce1'],['#72513d','#d79a68'],['#3e536f','#7eafbc']];
function paletteFor(seed='x'){let n=0;for(const c of seed)n=(n+c.charCodeAt(0))%997;return palettes[n%palettes.length];}
function titleFromFilename(name){return name.replace(/\.[^.]+$/,'').replace(/[._-]+/g,' ').trim()||'Faixa sem título';}
function decodeID3(buffer){
  try{const b=new Uint8Array(buffer);if(b.length<10||String.fromCharCode(...b.slice(0,3))!=='ID3')return{};const size=(b[6]<<21)|(b[7]<<14)|(b[8]<<7)|b[9];let p=10,end=Math.min(b.length,10+size),out={};while(p+10<end){let id=String.fromCharCode(...b.slice(p,p+4));if(!/^T[A-Z0-9]{3}$/.test(id))break;let len=(b[p+4]<<24)|(b[p+5]<<16)|(b[p+6]<<8)|b[p+7];if(len<=0||p+10+len>end)break;const encoding=b[p+10];let textBytes=b.slice(p+11,p+10+len);let value='';if(encoding===1||encoding===2){for(let i=0;i+1<textBytes.length;i+=2){const code=encoding===1?(textBytes[i+1]<<8)|textBytes[i]: (textBytes[i]<<8)|textBytes[i+1];if(code)value+=String.fromCharCode(code);}}else value=new TextDecoder(encoding===3?'utf-8':'windows-1252').decode(textBytes);value=value.replace(/\0/g,'').trim();if(id==='TIT2')out.title=value;if(id==='TPE1')out.artist=value;if(id==='TALB')out.album=value;if(id==='TCON')out.genre=value;p+=10+len;}return out;}catch{return{};}
}
async function makeLocalTrack(file){const buffer=await file.slice(0,Math.min(file.size,256*1024)).arrayBuffer();const tags=decodeID3(buffer);const name=tags.title||titleFromFilename(file.name);return{id:`local-${crypto.randomUUID()}`,title:name,artist:tags.artist||'Artista desconhecido',album:tags.album||'Arquivo local',duration:0,fileName:file.name,mime:file.type||'audio/mpeg',file,source:'local',plays:0,tags:tags.genre?[tags.genre]:[],addedAt:Date.now()};}
async function importFiles(files){const list=[...files].filter(f=>f.type.startsWith('audio/')||/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(f.name));if(!list.length){showToast('Não encontrei arquivos de áudio compatíveis.', 'error');return;}let count=0;for(const file of list){try{const track=await makeLocalTrack(file);await saveTrack(track);state.localTracks.unshift(track);count++;}catch(e){console.error(e);showToast(`Não consegui importar ${file.name}. Talvez o arquivo seja grande demais para o armazenamento disponível.`,'error');}}renderAll();showToast(`${count} ${count===1?'música importada':'músicas importadas'} e protegidas no cofre.`);}

function getTrackById(id){return state.localTracks.find(t=>t.id===id)||state.onlineTracks.find(t=>t.id===id)||state.savedOnline.find(t=>t.id===id)||state.communityTracks.find(t=>t.id===id)||null;}
function trackKey(t){return `${t.source}:${t.id}`;}
function isFavorite(t){return state.favorites.includes(trackKey(t));}
function toggleFavorite(t){const k=trackKey(t);const was=isFavorite(t);state.favorites=was?state.favorites.filter(x=>x!==k):[...state.favorites,k];if(t.source!=='local'&&!was&&!state.savedOnline.some(x=>x.id===t.id))state.savedOnline.unshift({...t});saveVault();renderAll();if($('#view-discover').classList.contains('active'))renderOnline();if(state.current?.id===t.id)updatePlayerLike();}
function sourceLabel(t){return t.source==='local'?'LOCAL':'AUDIOUS';}
function licenseLabel(t){
  if(t.source==='local')return 'ARQUIVO LOCAL';
  if(t.source==='community')return 'PUBLICADA NO SONORA';
  return 'STREAMING OFICIAL · AUDIOUS';
}
function createCover(track,large=false){
  const [a,b]=paletteFor(track.title+track.artist);
  const symbol=track.source==='local'?'♫':'✦';
  return '<div class="'+(large?'now-cover':'cover-art')+'" style="--cover-a:'+a+';--cover-b:'+b+'">'+
    (large?'<span>♫</span>':'<div class="cover-orbit"></div><span class="cover-symbol">'+symbol+'</span>')+'</div>';
}
function musicCard(t,index=0){
  const [a,b]=paletteFor(t.title+t.artist);
  const image=t.image&&/^https:\/\//i.test(t.image)?'<img src="'+safeText(t.image)+'" alt="" loading="lazy">':'';
  const original=t.originalUrl?'<a class="card-source-link" href="'+safeText(t.originalUrl)+'" target="_blank" rel="noopener noreferrer">Artista ↗</a>':'';
  return '<article class="music-card" style="animation-delay:'+Math.min(index,8)*.055+'s">'+
    '<div class="cover-art" style="--cover-a:'+a+';--cover-b:'+b+'">'+image+
    '<div class="cover-orbit"></div><span class="cover-symbol">✦</span>'+
    '<button class="cover-play" data-play="'+safeText(t.id)+'" title="Tocar">▶</button></div>'+
    '<div class="card-info"><strong title="'+safeText(t.title)+'">'+safeText(t.title)+'</strong>'+
    '<small>'+safeText(t.artist)+'</small><div class="card-meta"><span class="license-tag">'+licenseLabel(t)+'</span>'+
    '<button class="card-like '+(isFavorite(t)?'liked':'')+'" data-like="'+safeText(t.id)+'" title="Favoritar">'+(isFavorite(t)?'♥':'♡')+'</button></div>'+
    '<div class="card-actions"><button data-add-playlist="'+safeText(t.id)+'">＋ Playlist</button>'+original+'</div></div></article>';
}
function trackRow(t,index=0){
  const original=t.originalUrl?'<a class="row-action source-action" href="'+safeText(t.originalUrl)+'" target="_blank" rel="noopener noreferrer" title="Abrir no Audius">↗</a>':'';
  return '<div class="track-row"><span class="track-index">'+String(index+1).padStart(2,'0')+'</span>'+
    '<div class="track-mini-cover" style="--cover-a:'+paletteFor(t.title)[0]+';--cover-b:'+paletteFor(t.artist)[1]+'">'+
    (t.image&&/^https:\/\//i.test(t.image)?'<img src="'+safeText(t.image)+'" alt="" loading="lazy">':'♫')+'</div>'+
    '<div class="track-title"><strong>'+safeText(t.title)+'</strong><small>'+safeText(t.artist)+'</small></div>'+
    '<div class="track-album">'+safeText(t.album||sourceLabel(t))+'</div><span class="track-duration">'+(t.duration?formatTime(t.duration):'—')+'</span>'+
    '<button class="row-action like-action" data-like="'+safeText(t.id)+'" title="Favoritar">'+(isFavorite(t)?'♥':'♡')+'</button>'+
    '<button class="row-action playlist-action" data-add-playlist="'+safeText(t.id)+'" title="Adicionar à playlist">＋</button>'+
    '<button class="row-action play-action" data-play="'+safeText(t.id)+'" title="Tocar">▶</button>'+original+'</div>';
}
function bindTrackActions(root){
  $$('[data-play]',root).forEach(btn=>btn.addEventListener('click',()=>{
    const track=getTrackById(btn.dataset.play);
    if(track)playTrack(track);
  }));
  $$('[data-like]',root).forEach(btn=>btn.addEventListener('click',()=>{
    const track=getTrackById(btn.dataset.like);
    if(track)toggleFavorite(track);
  }));
  $$('[data-add-playlist]',root).forEach(btn=>btn.addEventListener('click',()=>{
    const track=getTrackById(btn.dataset.addPlaylist);
    if(track)choosePlaylist(track);
  }));
  $$('[data-download]',root).forEach(btn=>btn.addEventListener('click',()=>{
    const track=getTrackById(btn.dataset.download);
    if(track?.audiodownload_allowed&&track.audiodownload){
      const a=document.createElement('a');
      a.href=track.audiodownload;
      a.target='_blank';
      a.rel='noopener';
      a.download=`${track.title}.mp3`;
      document.body.append(a);
      a.click();
      a.remove();
      showToast('Abrindo o download autorizado pela fonte.');
    }
  }));
}
function renderHome(){const recommendations=buildRecommendations();$('#recommendation-grid').innerHTML=recommendations.length?recommendations.slice(0,4).map(musicCard).join(''):`<div class="empty-state">Adicione músicas ou faça uma busca online para começar a treinar seu algoritmo.</div>`;const recent=state.history.slice(0,5).map(h=>getTrackById(h.id)||h.track).filter(Boolean);$('#recent-list').innerHTML=recent.length?recent.map(trackRow).join(''):`<div class="empty-state">Suas reproduções recentes vão aparecer aqui.</div>`;bindTrackActions($('#view-home'));}
function renderLibrary(){let tracks=[...state.localTracks];if(state.libraryFilter==='recent')tracks.sort((a,b)=>b.addedAt-a.addedAt);if(state.libraryFilter==='favorites')tracks=tracks.filter(isFavorite);$('#library-count').textContent=`${tracks.length} ${tracks.length===1?'faixa':'faixas'}`;$('#library-list').innerHTML=tracks.length?tracks.map(trackRow).join(''):`<div class="empty-state">Sua biblioteca ainda está vazia. Arraste uma música para esta página ou use “Importar músicas”.</div>`;bindTrackActions($('#view-library'));}
function renderFavorites(){const all=[...state.localTracks,...state.onlineTracks,...state.savedOnline];const tracks=state.favorites.map(k=>all.find(t=>trackKey(t)===k)).filter(Boolean);$('#favorites-list').innerHTML=tracks.length?tracks.map(trackRow).join(''):`<div class="empty-state">Toque no coração de uma faixa para guardá-la aqui.</div>`;bindTrackActions($('#view-favorites'));}
function renderPlaylists(){const root=$('#playlist-cards');root.innerHTML=state.playlists.length?state.playlists.map((p,i)=>`<div class="playlist-card" data-open-playlist="${safeText(p.id)}"><div class="playlist-art" style="background:linear-gradient(135deg,${paletteFor(p.name)[0]},${paletteFor(p.name)[1]})">♫</div><strong>${safeText(p.name)}</strong><p>${p.tracks.length} ${p.tracks.length===1?'faixa':'faixas'}</p></div>`).join(''):`<div class="empty-state">Crie sua primeira playlist e organize as músicas por clima, momento ou estilo.</div>`;$$('[data-open-playlist]').forEach(el=>el.addEventListener('click',()=>openPlaylist(el.dataset.openPlaylist)));renderSidebarPlaylists();}
function renderSidebarPlaylists(){$('#sidebar-playlists-list').innerHTML=state.playlists.slice(0,5).map(p=>`<button class="sidebar-playlist" data-open-playlist="${safeText(p.id)}">♫ ${safeText(p.name)}</button>`).join('');$$('[data-open-playlist]',$('#sidebar-playlists-list')).forEach(el=>el.addEventListener('click',()=>{switchView('playlists');openPlaylist(el.dataset.openPlaylist);}));}
function renderAll(){if(!state.user)return;refreshAccountIdentity();renderHome();renderLibrary();renderFavorites();renderPlaylists();renderReels();$('#algorithm-summary').textContent=algorithmSummary();}
function renderOnline(){const root=$('#online-results');root.innerHTML=state.onlineTracks.length?state.onlineTracks.map(musicCard).join(''):`<div class="empty-state">Nenhum resultado nesta busca. Tente outro termo.</div>`;bindTrackActions(root);}

function extractGenres(track){const raw=[...(track.tags||[]),...(track.musicinfo?.tags?.genres||[]),...(track.musicinfo?.tags?.vartags||[])];return raw.map(x=>String(typeof x==='object'?(x.name||x.tag||''):x).toLowerCase()).filter(Boolean);}
function buildRecommendations(){const all=[...state.localTracks,...state.onlineTracks,...state.savedOnline];if(!all.length)return[];const pref={};for(const h of state.history){const t=all.find(x=>x.id===h.id)||h.track;if(!t)continue;for(const g of extractGenres(t))pref[g]=(pref[g]||0)+2+(h.plays||1);pref[t.artist]=(pref[t.artist]||0)+1.5;}for(const k of state.favorites){const t=all.find(x=>trackKey(x)===k);if(t){for(const g of extractGenres(t))pref[g]=(pref[g]||0)+4;pref[t.artist]=(pref[t.artist]||0)+3;}}return all.map(t=>({...t,_score:(t.plays||0)*.8+(isFavorite(t)?4:0)+extractGenres(t).reduce((s,g)=>s+(pref[g]||0),0)+(pref[t.artist]||0)+(t.source==='audius'?0.8:0)})).sort((a,b)=>b._score-a._score).slice(0,8);}
function algorithmSummary(){const all=[...state.localTracks,...state.onlineTracks,...state.savedOnline];if(!state.history.length&&!state.favorites.length)return 'O algoritmo ainda está na fase de descoberta. Ouça algumas músicas e favorite as que gostar para receber recomendações mais certeiras.';const scores={};for(const h of state.history){const t=all.find(x=>x.id===h.id)||h.track;if(t){for(const g of extractGenres(t))scores[g]=(scores[g]||0)+1;}}const top=Object.entries(scores).sort((a,b)=>b[1]-a[1]).slice(0,3).map(x=>x[0]);return top.length?`Seu histórico indica interesse em: ${top.join(', ')}. As recomendações combinam gêneros, artistas, favoritos e frequência de reprodução.`:`Você já tem ${state.history.length} reprodução(ões) registradas. Continue ouvindo para o algoritmo reconhecer seus estilos.`;}


const AUDIOUS_API_BASES=['https://api.audius.co/v1','https://discoveryprovider.audius.co/v1'];
async function audiusRequest(path,params={}){
  const errors=[];
  for(const base of AUDIOUS_API_BASES){
    try{
      const url=new URL(base+path);
      Object.entries({app_name:'Sonora',...params}).forEach(([key,value])=>{if(value!==undefined&&value!==null&&value!=='')url.searchParams.set(key,String(value));});
      const response=await fetch(url.toString(),{headers:{Accept:'application/json'}});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const json=await response.json();
      if(json.error)throw new Error(String(json.error));
      return {items:Array.isArray(json.data)?json.data:[],base};
    }catch(error){errors.push(error.message||String(error));}
  }
  throw new Error('O catálogo Audius não respondeu. '+errors.join(' · '));
}
function mapAudiusTrack(track,base){
  if(!track||!track.id||track.is_streamable===false)return null;
  const user=track.user||{};
  const artwork=track.artwork;
  const image=typeof artwork==='string'?artwork:(artwork?.['480x480']||artwork?.['150x150']||artwork?.['1000x1000']||'');
  const rawTags=typeof track.tags==='string'?track.tags.split(/[;,]/):[];
  const tags=[track.genre,...rawTags].filter(Boolean).map(x=>String(x).trim()).filter(Boolean);
  let originalUrl=track.permalink||'';
  if(originalUrl&&!/^https?:\/\//i.test(originalUrl))originalUrl='https://audius.co'+(originalUrl.startsWith('/')?'':'/')+originalUrl;
  if(!originalUrl)originalUrl='https://audius.co';
  return {
    id:'audius-'+String(track.id),providerId:String(track.id),
    title:track.title||'Faixa sem título',
    artist:user.name||user.handle||track.artist_name||'Artista independente',
    album:track.album_title||'Lançamento independente',
    duration:Number(track.duration)||0,image,
    audio:base+'/tracks/'+encodeURIComponent(track.id)+'/stream?app_name=Sonora',
    originalUrl,source:'audius',plays:Number(track.play_count)||0,
    tags,genre:track.genre||'',license:track.license||null,
    isStreamable:track.is_streamable!==false
  };
}
async function loadAudiusCatalog(options={}){
  const requestId=++state.catalogRequestId;
  const query=String(options.query||'').trim();
  const genre=String(options.genre||'').trim();
  const searchTerm=query||genre;
  const status=$('#online-status');
  if(status)status.textContent=searchTerm?'Pesquisando no catálogo Audius...':'Carregando músicas em alta no Audius...';
  $('#online-results').innerHTML='<div class="loading-line"><span></span> Preparando o catálogo musical...</div>';
  try{
    let result=await audiusRequest(searchTerm?'/tracks/search':'/tracks/trending',
      searchTerm?{query:searchTerm,limit:36}:{limit:36,time:'week'});
    if(!result.items.length&&!searchTerm)result=await audiusRequest('/tracks/latest',{limit:36});
    if(requestId!==state.catalogRequestId)return;
    state.onlineTracks=result.items.map(track=>mapAudiusTrack(track,result.base)).filter(Boolean);
    renderOnline();
    if(status)status.textContent=state.onlineTracks.length?
      state.onlineTracks.length+' faixas prontas para ouvir · catálogo Audius':
      'Nenhuma faixa reproduzível apareceu agora. Atualize o catálogo ou tente outra categoria.';
    if($('#view-home').classList.contains('active'))renderHome();
  }catch(error){
    if(requestId!==state.catalogRequestId)return;
    console.error('Audius:',error);
    state.onlineTracks=[];
    renderOnline();
    if(status)status.textContent='Não consegui carregar o catálogo agora. Verifique a conexão e tente Atualizar catálogo. ('+error.message+')';
    if($('#view-home').classList.contains('active'))renderHome();
  }
}
async function runOnlineSearch(query){
  const value=String(query||'').trim();
  if(!value){await loadAudiusCatalog();return;}
  await loadAudiusCatalog({query:value});
}


async function playTrack(track){
  if(!track)return;
  try{
    if(state.currentObjectUrl){URL.revokeObjectURL(state.currentObjectUrl);state.currentObjectUrl=null;}
    if(track.source==='local'){
      state.currentObjectUrl=URL.createObjectURL(track.file);
      audio.src=state.currentObjectUrl;
    }else{
      if(!track.audio)throw new Error('Esta faixa não possui um endereço de streaming disponível.');
      audio.src=track.audio;
    }
    state.current=track;
    state.queue=[...new Map([...state.onlineTracks,...state.localTracks,...state.savedOnline,...state.communityTracks].map(t=>[trackKey(t),t])).values()];
    state.queueIndex=state.queue.findIndex(t=>trackKey(t)===trackKey(track));
    $('#player-title').textContent=track.title;
    $('#player-artist').textContent=track.artist;
    $('#now-cover').innerHTML='<span>♫</span>';
    $('#player-like').classList.toggle('liked',isFavorite(track));
    $('#player-like').textContent=isFavorite(track)?'♥':'♡';
    audio.volume=Number($('#volume-bar').value);
    await audio.play();
    track.plays=(track.plays||0)+1;
    registerPlay(track);
    renderHome();
  }catch(error){console.warn(error);showToast(error.message||'Não foi possível tocar essa faixa.','error');}
}

function registerPlay(track){const found=state.history.find(h=>h.id===track.id);if(found){found.plays=(found.plays||1)+1;found.track=track;}else state.history.unshift({id:track.id,plays:1,track});state.history=state.history.slice(0,40);saveVault();$('#algorithm-summary').textContent=algorithmSummary();}
function updatePlayerLike(){if(!state.current)return;const liked=isFavorite(state.current);$('#player-like').classList.toggle('liked',liked);$('#player-like').textContent=liked?'♥':'♡';}
function playNext(direction=1){if(!state.queue.length)return;let next;if(state.shuffle)next=Math.floor(Math.random()*state.queue.length);else next=(state.queueIndex+direction+state.queue.length)%state.queue.length;state.queueIndex=next;playTrack(state.queue[next]);}

audio.addEventListener('play',()=>$('#play-btn').textContent='Ⅱ');audio.addEventListener('pause',()=>$('#play-btn').textContent='▶');audio.addEventListener('timeupdate',()=>{if(!audio.duration)return;$('#seek-bar').value=Math.round(audio.currentTime/audio.duration*1000);$('#current-time').textContent=formatTime(audio.currentTime);$('#total-time').textContent=formatTime(audio.duration);});audio.addEventListener('loadedmetadata',()=>{$('#total-time').textContent=formatTime(audio.duration);if(state.current&&state.current.source==='local'){state.current.duration=audio.duration;renderHome();renderLibrary();}});audio.addEventListener('ended',()=>{if(state.repeat){audio.currentTime=0;audio.play();}else playNext(1);});

function switchView(view){$$('.content-view').forEach(x=>x.classList.remove('active'));$(`#view-${view}`)?.classList.add('active');$$('.nav-link').forEach(x=>x.classList.toggle('active',x.dataset.view===view));const names={home:'Início',discover:'Descobrir',community:'Comunidade',profile:'Meu perfil',library:'Minha biblioteca',favorites:'Favoritas',playlists:'Playlists',reels:'Reels · Rascunhos',settings:'Preferências'};$('#breadcrumb-current').textContent=names[view]||view;if(view==='reels')renderReels();if(view==='discover'){renderOnline();if(!state.onlineTracks.length)loadAudiusCatalog();}if(view==='community'){renderCommunityFeed();loadCommunityTracks();}if(view==='profile')renderProfilePage();window.scrollTo({top:0,behavior:'smooth'});}
const reelConcepts = [
  ['A batida que muda tudo','Comece com uma cena calma e troque para cortes rápidos quando a batida entrar.'],
  ['Meu som favorito em 15 segundos','Apresente um trecho musical e escreva o motivo de ele ter virado seu favorito.'],
  ['Luzes no ritmo','Faça as cores da cena mudarem acompanhando a música.'],
  ['Um dia em três cenas','Conte uma pequena história com começo, meio e fim em poucos segundos.'],
  ['POV: começou minha música','Mostre uma reação ou mudança de ambiente quando a faixa começa.'],
  ['Transição no refrão','Planeje uma transição visual no início do refrão.'],
  ['A playlist do momento','Mostre três faixas que combinam com um mesmo clima.'],
  ['Som ambiente + música','Misture um som cotidiano com uma trilha suave.'],
  ['Antes e depois criativo','Compare duas cenas com uma transição sincronizada.'],
  ['Visualizador de áudio','Crie uma composição com formas e cores que pulsam com o som.'],
  ['Um instrumento, vários sons','Apresente um instrumento ou timbre em pequenos cortes.'],
  ['A música e a paisagem','Combine uma paisagem com uma trilha que combine com ela.'],
  ['Loop que encaixa','Monte um final que se conecte com o primeiro quadro.'],
  ['Descoberta musical da semana','Apresente uma faixa nova e destaque o que chamou sua atenção.'],
  ['Capa animada','Transforme uma arte original em uma pequena animação vertical.'],
  ['Ritmo em objetos','Use objetos comuns como elementos visuais, sem fazer desafios perigosos.'],
  ['Bastidores da criação','Mostre partes do processo criativo em sequência.'],
  ['Três humores, uma música','Represente três climas diferentes usando a mesma trilha.'],
  ['O drop em câmera lenta','Prepare uma cena para o ponto alto da música.'],
  ['Créditos da faixa','Apresente artista, título e a licença quando for uma música reutilizada.']
];
const reelFormats=[['versão cinematográfica','Planeje um início marcante, um detalhe em close e um encerramento visual.'],['edição com cortes rápidos','Marque os pontos da batida onde os cortes podem acontecer.'],['estética lo-fi','Use uma paleta suave, textura discreta e movimentos tranquilos.'],['cores neon','Experimente contraste de cores e luzes acompanhando o ritmo.'],['loop perfeito','Planeje o último quadro para combinar com o primeiro.']];
function makeSeedReels(){const drafts=[];for(let i=0;i<100;i++){const concept=reelConcepts[i%reelConcepts.length];const style=reelFormats[Math.floor(i/reelConcepts.length)%reelFormats.length];const states=['Ideia inicial','Roteiro incompleto','Falta gravar','Edição pendente'];drafts.push({id:`seed-reel-${String(i+1).padStart(3,'0')}`,title:`${concept[0]} · ${style[0]}`,description:`${concept[1]} ${style[1]}`,stage:states[i%states.length],progress:[12,24,36,18,42][i%5],createdAt:Date.now()-(100-i)*60000,seed:true,hasVideo:false});}return drafts;}
function reelHue(index){const colors=[['#794d96','#e17cba'],['#235d78','#75cbd3'],['#6555a0','#a5a3ff'],['#985b47','#e5a36f'],['#345d65','#72c7a8'],['#59466f','#cc8eb1']];return colors[index%colors.length];}
function renderReels(){const root=$('#reels-grid');if(!root)return;const q=(state.reelSearch||'').toLowerCase();let list=state.reelsDrafts.filter(r=>(`${r.title} ${r.description} ${r.stage}`).toLowerCase().includes(q));if(state.reelFilter==='video')list=list.filter(r=>r.hasVideo);if(state.reelFilter==='idea')list=list.filter(r=>!r.hasVideo);const total=state.reelsDrafts.length;$('#reels-total').textContent=total;$('#reels-with-video').textContent=state.reelsDrafts.filter(r=>r.hasVideo).length;$('#reels-in-progress').textContent=state.reelsDrafts.filter(r=>!r.completed).length;$('#reels-count').textContent=`${list.length} ${list.length===1?'projeto':'projetos'}`;const shown=list.slice(0,state.reelsVisible);root.innerHTML=shown.length?shown.map((r,i)=>{const c=reelHue((state.reelsDrafts.indexOf(r)+i)%6);return `<article class="reel-project-card"><div class="reel-poster" style="--reel-a:${c[0]};--reel-b:${c[1]}"><span class="reel-poster-label">SONORA / RASCUNHO</span><div class="reel-poster-art">${r.hasVideo?'▶':'♫'}</div><span class="reel-poster-title">${safeText(r.title)}</span><span class="reel-poster-bottom">${r.hasVideo?'VÍDEO ADICIONADO':'AINDA SEM VÍDEO'}</span><span class="reel-play-overlay">${r.hasVideo?'▶':'✎'}</span></div><div class="reel-card-info"><div class="reel-card-meta"><span class="reel-status">${safeText(r.stage||'Rascunho')}</span><span>${Math.max(0,Math.min(100,Number(r.progress)||0))}%</span></div><div class="reel-progress"><i style="width:${Math.max(0,Math.min(100,Number(r.progress)||0))}%"></i></div><p>${safeText(r.description||'Adicione uma descrição para desenvolver esta ideia.')}</p><div class="reel-card-actions"><button class="reel-edit-btn" data-reel-edit="${safeText(r.id)}">Editar rascunho</button><button class="reel-preview-btn" data-reel-preview="${safeText(r.id)}" title="Pré-visualizar">▷</button></div></div></article>`}).join(''):`<div class="empty-state">Nenhum rascunho encontrado. Tente outra busca ou crie um novo Reel.</div>`;$('#reels-load-more').classList.toggle('hidden',shown.length>=list.length);}
function createReelDraft(){const draft={id:crypto.randomUUID(),title:'Meu novo Reel',description:'',stage:'Ideia inicial',progress:5,createdAt:Date.now(),seed:false,hasVideo:false};state.reelsDrafts.unshift(draft);state.reelSearch='';$('#reels-search').value='';state.reelFilter='all';$$('.reel-filter').forEach(x=>x.classList.toggle('active',x.dataset.reelFilter==='all'));state.reelsVisible=20;saveVault();renderReels();openReelEditor(draft.id);}
async function getReelVideoUrl(draft){
  const meta=await dbGet('media',`reel-meta:${draft.id}`);
  if(meta&&meta.chunkCount){
    const parts=[];
    for(let index=0;index<meta.chunkCount;index++){
      const id=`reel-chunk:${draft.id}:${meta.uploadId}:${index}`;
      const chunk=await dbGet('media',id);
      if(!chunk)throw new Error(`O bloco ${index+1} do vídeo não foi encontrado no cofre.`);
      const additionalData=enc.encode(`sonora-reel:${draft.id}:${meta.uploadId}:${index}`);
      const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(chunk.iv),additionalData},state.key,chunk.data);
      parts.push(clear);
    }
    return URL.createObjectURL(new Blob(parts,{type:meta.mediaType||draft.mediaType||'video/mp4'}));
  }
  // Compatibilidade com vídeos guardados pela versão 1.0 (arquivo único).
  const legacy=await dbGet('vault',`reel-media:${draft.id}`);
  if(!legacy)return null;
  const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(legacy.iv)},state.key,legacy.data);
  return URL.createObjectURL(new Blob([clear],{type:draft.mediaType||'video/mp4'}));
}
async function saveReelVideo(draft,file,onProgress=()=>{}){
  if(file.size>MAX_REEL_VIDEO_BYTES)throw new Error('O limite é 1 GB por vídeo. Escolha um arquivo menor.');
  if(!file.size)throw new Error('O arquivo está vazio. Escolha outro vídeo.');
  if(!state.key)throw new Error('O cofre está bloqueado. Entre novamente para salvar.');
  try{if(navigator.storage?.persist)await navigator.storage.persist();}catch{}
  if(navigator.storage?.estimate){
    try{
      const estimate=await navigator.storage.estimate();
      const available=Number(estimate.quota||0)-Number(estimate.usage||0);
      if(available>0&&available<file.size*1.03){
        const availableMb=Math.max(0,available/1024/1024).toFixed(0);
        throw new Error(`Espaço insuficiente no navegador. Há aproximadamente ${availableMb} MB livres; o vídeo precisa de ${formatBytes(file.size)} ou mais.`);
      }
    }catch(error){if(error instanceof Error&&error.message.startsWith('Espaço insuficiente'))throw error;}
  }
  const uploadId=crypto.randomUUID();
  const prefix=`reel-chunk:${draft.id}:${uploadId}:`;
  const chunkCount=Math.ceil(file.size/REEL_VIDEO_CHUNK_BYTES);
  try{
    for(let index=0;index<chunkCount;index++){
      const start=index*REEL_VIDEO_CHUNK_BYTES;
      const end=Math.min(file.size,start+REEL_VIDEO_CHUNK_BYTES);
      const raw=await file.slice(start,end).arrayBuffer();
      const iv=crypto.getRandomValues(new Uint8Array(12));
      const additionalData=enc.encode(`sonora-reel:${draft.id}:${uploadId}:${index}`);
      const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData},state.key,raw);
      await dbPut('media',{id:`${prefix}${index}`,iv:toB64(iv),data:encrypted});
      onProgress({done:index+1,total:chunkCount,percent:Math.round(((index+1)/chunkCount)*100)});
    }
    const meta={id:`reel-meta:${draft.id}`,uploadId,chunkCount,chunkSize:REEL_VIDEO_CHUNK_BYTES,size:file.size,fileName:file.name,mediaType:file.type||'video/mp4',savedAt:Date.now()};
    await dbPut('media',meta);
    // Remove blocks from a previously attached video only after the new video is safely saved.
    await dbDeletePrefix('media',`reel-chunk:${draft.id}:`,prefix);
    await dbDelete('vault',`reel-media:${draft.id}`);
    draft.hasVideo=true;draft.mediaName=file.name;draft.mediaType=meta.mediaType;draft.mediaSize=file.size;
  }catch(error){
    await dbDeletePrefix('media',prefix).catch(()=>{});
    throw error;
  }
}
function formatBytes(bytes){if(!Number.isFinite(bytes)||bytes<0)return '0 B';const units=['B','KB','MB','GB'];let value=bytes,index=0;while(value>=1024&&index<units.length-1){value/=1024;index++;}return `${value.toFixed(index===0?0:1)} ${units[index]}`;}

async function openReelEditor(id){const draft=state.reelsDrafts.find(r=>r.id===id);if(!draft)return;openModal(`<div class="reel-editor"><span class="eyebrow">SONORA CREATOR LAB</span><h2>Editar rascunho</h2><p>Esse projeto ainda está em construção. Preencha o que já souber e salve quando quiser.</p><label for="reel-title-input">Título</label><input id="reel-title-input" maxlength="90" value="${safeText(draft.title)}"><label for="reel-description-input">Ideia / legenda</label><textarea id="reel-description-input" rows="4" maxlength="1000">${safeText(draft.description||'')}</textarea><label for="reel-stage-input">Etapa do projeto</label><select id="reel-stage-input"><option>Ideia inicial</option><option>Roteiro incompleto</option><option>Falta gravar</option><option>Edição pendente</option><option>Quase pronto</option></select><label for="reel-progress-input">Progresso estimado <output id="reel-progress-output">${draft.progress||0}%</output></label><input id="reel-progress-input" type="range" min="0" max="95" step="5" value="${draft.progress||0}"><label for="reel-video-input">Vídeo vertical (opcional)</label><input id="reel-video-input" type="file" accept="video/*"><small class="reel-file-note">Até 1 GB por vídeo. O arquivo é criptografado em blocos de 8 MB e fica neste navegador. O espaço disponível depende do navegador e do dispositivo.</small><div id="reel-upload-progress" class="reel-upload-progress hidden"><div class="reel-upload-track"><i id="reel-upload-bar"></i></div><span id="reel-upload-label">Preparando vídeo…</span></div><div id="reel-video-preview" class="reel-video-preview">${draft.hasVideo?`<div class="reel-video-placeholder">Vídeo salvo: ${safeText(draft.mediaName||'arquivo de vídeo')}</div>`:'<div class="reel-video-placeholder">Ainda não há vídeo neste rascunho.</div>'}</div><div class="reel-editor-actions"><button class="outline-btn" id="reel-delete-btn">Excluir rascunho</button><span></span><button class="primary-btn" id="reel-save-btn">Salvar rascunho ✓</button></div></div>`);$('#reel-stage-input').value=draft.stage||'Ideia inicial';let fileToSave=null,previewUrl=null;const updateProgress=()=>$('#reel-progress-output').textContent=`${$('#reel-progress-input').value}%`;$('#reel-progress-input').addEventListener('input',updateProgress);$('#reel-video-input').addEventListener('change',async e=>{fileToSave=e.target.files?.[0]||null;if(!fileToSave)return;if(!fileToSave.type.startsWith('video/')&&!/\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i.test(fileToSave.name)){showToast('Escolha um arquivo de vídeo compatível.','error');e.target.value='';fileToSave=null;return;}if(fileToSave.size>MAX_REEL_VIDEO_BYTES){showToast('O limite é 1 GB por vídeo.','error');e.target.value='';fileToSave=null;return;}if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(fileToSave);$('#reel-video-preview').innerHTML=`<video controls playsinline src="${previewUrl}"></video><small class="reel-preview-size">${safeText(fileToSave.name)} · ${formatBytes(fileToSave.size)}</small>`;});$('#reel-delete-btn').addEventListener('click',async()=>{if(!window.confirm('Excluir este projeto de Reel?'))return;await dbDelete('vault',`reel-media:${draft.id}`);await dbDelete('media',`reel-meta:${draft.id}`);await dbDeletePrefix('media',`reel-chunk:${draft.id}:`);state.reelsDrafts=state.reelsDrafts.filter(r=>r.id!==draft.id);await saveVault();if(previewUrl)URL.revokeObjectURL(previewUrl);closeModal();renderReels();showToast('Rascunho excluído.');});$('#reel-save-btn').addEventListener('click',async()=>{const title=$('#reel-title-input').value.trim();if(!title){showToast('Digite um título para o rascunho.','error');return;}try{draft.title=title;draft.description=$('#reel-description-input').value.trim();draft.stage=$('#reel-stage-input').value;draft.progress=Number($('#reel-progress-input').value);if(fileToSave){const progressBox=$('#reel-upload-progress'),progressBar=$('#reel-upload-bar'),progressLabel=$('#reel-upload-label');progressBox.classList.remove('hidden');$('#reel-save-btn').disabled=true;$('#reel-save-btn').textContent='Criptografando…';await saveReelVideo(draft,fileToSave,({done,total,percent})=>{progressBar.style.width=`${percent}%`;progressLabel.textContent=`Criptografando bloco ${done} de ${total} · ${percent}%`;});}draft.completed=draft.progress>=95;await saveVault();if(previewUrl)URL.revokeObjectURL(previewUrl);closeModal();renderReels();showToast('Rascunho salvo no cofre local.');}catch(err){console.error(err);const saveButton=$('#reel-save-btn');if(saveButton){saveButton.disabled=false;saveButton.textContent='Tentar novamente';}showToast(err.message||'Não foi possível salvar o vídeo.','error');}});}
async function openReelPreview(id){const draft=state.reelsDrafts.find(r=>r.id===id);if(!draft)return;openModal(`<div class="reel-preview-modal"><span class="eyebrow">PRÉ-VISUALIZAÇÃO</span><h2>${safeText(draft.title)}</h2><p>${safeText(draft.description||'Este projeto ainda precisa de uma descrição.')}</p><div id="reel-preview-stage" class="reel-preview-stage"><div class="reel-preview-placeholder"><span>♫</span><strong>Seu Reel começa aqui</strong><small>Projeto inacabado · ${safeText(draft.stage||'Ideia inicial')}</small></div></div><div class="modal-actions"><button class="outline-btn" id="reel-preview-close">Fechar</button><button class="primary-btn" id="reel-preview-edit">Continuar editando →</button></div></div>`);$('#reel-preview-close').addEventListener('click',closeModal);$('#reel-preview-edit').addEventListener('click',()=>openReelEditor(id));if(draft.hasVideo){try{const url=await getReelVideoUrl(draft);if(url){state.reelPreviewUrl=url;const stage=$('#reel-preview-stage');stage.innerHTML=`<video controls playsinline src="${url}"></video>`;}}catch(e){console.warn('Preview video unavailable',e);}}}

function createPlaylist(){openModal(`<h2>Nova playlist</h2><p>Dê um nome para sua coleção. Você poderá adicionar músicas a ela enquanto escuta.</p><label for="playlist-name">Nome da playlist</label><input id="playlist-name" maxlength="38" placeholder="Ex.: Noite tranquila"><div class="modal-actions"><button class="outline-btn" id="cancel-modal">Cancelar</button><button class="primary-btn" id="confirm-playlist">Criar playlist →</button></div>`);$('#confirm-playlist').addEventListener('click',()=>{const name=$('#playlist-name').value.trim();if(!name){showToast('Digite um nome para a playlist.','error');return;}state.playlists.unshift({id:crypto.randomUUID(),name,tracks:[]});saveVault();closeModal();renderPlaylists();showToast('Playlist criada!');});$('#cancel-modal').addEventListener('click',closeModal);}
function openPlaylist(id){const p=state.playlists.find(x=>x.id===id);if(!p)return;state.activePlaylist=id;$('#playlist-detail').classList.remove('hidden');$('#playlist-cards').classList.add('hidden');$('#playlist-detail-title').textContent=p.name;$('#playlist-detail-subtitle').textContent=`${p.tracks.length} faixa(s) nesta playlist`;const tracks=p.tracks.map(k=>[...state.localTracks,...state.onlineTracks,...state.savedOnline].find(t=>trackKey(t)===k)).filter(Boolean);$('#playlist-detail-list').innerHTML=tracks.length?tracks.map(trackRow).join(''):`<div class="empty-state">Esta playlist ainda está vazia. Use o botão “Adicionar à playlist” nas opções de uma faixa.</div>`;bindTrackActions($('#playlist-detail-list'));}
function closePlaylist(){state.activePlaylist=null;$('#playlist-detail').classList.add('hidden');$('#playlist-cards').classList.remove('hidden');}
function openModal(html){if(state.reelPreviewUrl){URL.revokeObjectURL(state.reelPreviewUrl);state.reelPreviewUrl=null;}$('#modal-content').innerHTML=html;$('#modal-overlay').classList.remove('hidden');}function closeModal(){if(state.reelPreviewUrl){URL.revokeObjectURL(state.reelPreviewUrl);state.reelPreviewUrl=null;}$('#modal-overlay').classList.add('hidden');}

function setAvatarElement(el,url,name){if(!el)return;if(url)el.innerHTML='<img src="'+safeText(url)+'" alt="">';else el.textContent=(name||'S').trim().charAt(0).toUpperCase()||'S';}
function refreshAccountIdentity(){if(!state.user)return;$('#sidebar-username').textContent=state.user.name||'Ouvinte';$('#top-username').textContent=state.user.name||'Ouvinte';setAvatarElement($('#user-avatar'),state.user.avatarUrl,state.user.name);setAvatarElement($('#top-avatar'),state.user.avatarUrl,state.user.name);const small=$('.mini-profile small');if(small)small.textContent=state.cloudUser?'Conta online':'Visitante';const status=$('.local-encryption');if(status)status.innerHTML=state.cloudUser?'<span>●</span> Conta online':'<span>●</span> Modo visitante';}
async function loadCommunityTracks(){const root=$('#community-feed');if(!state.supabaseClient){if(root)root.innerHTML='<div class="empty-state">Conecte o banco online para ver publicações.</div>';return;}if(root)root.innerHTML='<div class="loading-line"><span></span> Carregando publicações...</div>';try{const r=await state.supabaseClient.from('tracks').select('id,user_id,title,artist,description,audio_url,cover_url,audio_path,cover_path,created_at').eq('status','published').order('created_at',{ascending:false}).limit(60);if(r.error)throw r.error;const rows=r.data||[],ids=[...new Set(rows.map(t=>t.user_id))];let profiles=[];if(ids.length){const p=await state.supabaseClient.from('profiles').select('id,username,display_name,avatar_url').in('id',ids);if(p.error)throw p.error;profiles=p.data||[];}const map=new Map(profiles.map(x=>[x.id,x]));state.communityTracks=rows.map(t=>{const p=map.get(t.user_id)||{};return Object.assign({},t,{source:'community',audio:t.audio_url,artist:t.artist||p.display_name||p.username||'Artista',publisher:p.display_name||p.username||'Ouvinte',username:p.username||'ouvinte',publisherAvatar:p.avatar_url||''});});renderCommunityFeed();}catch(e){console.error(e);if(root)root.innerHTML='<div class="empty-state">Erro ao carregar publicações. Confira a configuração do banco.</div>';}}
function renderCommunityFeed(){const root=$('#community-feed');if(!root)return;const form=$('#publish-music-form'),signin=$('#community-signin-note');if(form)form.classList.toggle('hidden',!state.cloudUser);if(signin)signin.classList.toggle('hidden',!!state.cloudUser);if(!state.communityTracks.length){root.innerHTML='<div class="empty-state">Ainda não há músicas publicadas. Compartilhe uma faixa original para começar!</div>';return;}root.innerHTML=state.communityTracks.map(t=>{const owner=!!(state.cloudUser&&state.cloudUser.id===t.user_id);const cover=t.cover_url&&/^https:\/\//i.test(t.cover_url)?'<img src="'+safeText(t.cover_url)+'" alt="">':'<span>♫</span>';const avatar=t.publisherAvatar&&/^https:\/\//i.test(t.publisherAvatar)?'<img class="community-avatar" src="'+safeText(t.publisherAvatar)+'" alt="">':'<span class="community-avatar community-avatar-fallback">'+safeText((t.publisher||'O').charAt(0).toUpperCase())+'</span>';const date=t.created_at?new Date(t.created_at).toLocaleDateString('pt-BR'):'';return '<article class="community-track-card"><div class="community-cover">'+cover+'</div><div class="community-track-info"><div class="community-byline">'+avatar+'<span><strong>'+safeText(t.publisher)+'</strong><small>@'+safeText(t.username)+' · '+safeText(date)+'</small></span></div><h3>'+safeText(t.title)+'</h3><p class="community-artist">'+safeText(t.artist)+'</p>'+(t.description?'<p class="community-description">'+safeText(t.description)+'</p>':'')+'<div class="community-card-actions"><button class="primary-btn" data-play="'+safeText(t.id)+'">▶ Ouvir</button>'+(owner?'<button class="outline-btn" data-delete-track="'+safeText(t.id)+'">Remover</button>':'<button class="outline-btn" data-report-track="'+safeText(t.id)+'">Denunciar</button>')+'</div></div></article>';}).join('');bindTrackActions(root);}
function renderProfilePage(){if(!state.user)return;const cloud=!!state.cloudUser;$('#profile-display-name').textContent=state.user.name||'Ouvinte';$('#profile-handle').textContent='@'+(state.user.username||'visitante');$('#profile-email').textContent=state.user.email||'Modo visitante';$('#profile-name-input').value=(state.cloudProfile&&state.cloudProfile.display_name)||state.user.name||'';$('#profile-username-input').value=(state.cloudProfile&&state.cloudProfile.username)||state.user.username||'';$('#profile-bio-input').value=(state.cloudProfile&&state.cloudProfile.bio)||'';$('#profile-edit-fields').classList.toggle('hidden',!cloud);$('#profile-login-note').classList.toggle('hidden',cloud);setAvatarElement($('#profile-avatar-preview'),state.user.avatarUrl,state.user.name);$('#profile-published-count').textContent=String(state.communityTracks.filter(t=>t.user_id===(state.cloudUser&&state.cloudUser.id)).length);}
async function uploadSonoraMedia(file,path){const r=await state.supabaseClient.storage.from('sonora-media').upload(path,file,{cacheControl:'3600',upsert:true,contentType:file.type});if(r.error)throw r.error;const p=state.supabaseClient.storage.from('sonora-media').getPublicUrl(r.data.path);return {path:r.data.path,url:p.data.publicUrl};}
async function handleProfileSave(e){e.preventDefault();if(!state.cloudUser)throw new Error('Entre para editar seu perfil.');const display_name=$('#profile-name-input').value.trim(),username=$('#profile-username-input').value.trim().toLowerCase(),bio=$('#profile-bio-input').value.trim();if(display_name.length<2||display_name.length>40)throw new Error('Nome de exibição: 2 a 40 caracteres.');if(!/^[a-z0-9_]{3,24}$/.test(username))throw new Error('Nome de usuário: 3 a 24 caracteres.');if(bio.length>160)throw new Error('A bio pode ter até 160 caracteres.');const r=await state.supabaseClient.from('profiles').update({display_name,username,bio}).eq('id',state.cloudUser.id).select('*').single();if(r.error)throw r.error;state.cloudProfile=r.data;state.user=Object.assign({},state.user,{name:r.data.display_name,username:r.data.username,bio:r.data.bio,avatarUrl:r.data.avatar_url||''});refreshAccountIdentity();renderProfilePage();showToast('Perfil atualizado!');}
async function handleAvatarChange(e){const file=e.target.files&&e.target.files[0];e.target.value='';if(!file)return;try{if(!state.cloudUser)throw new Error('Entre para enviar foto.');if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Use JPG, PNG ou WebP.');if(file.size>2*1024*1024)throw new Error('A foto deve ter até 2 MB.');const ext=file.type==='image/png'?'png':(file.type==='image/webp'?'webp':'jpg');const u=await uploadSonoraMedia(file,state.cloudUser.id+'/avatars/avatar.'+ext);const r=await state.supabaseClient.from('profiles').update({avatar_url:u.url,avatar_path:u.path}).eq('id',state.cloudUser.id).select('*').single();if(r.error)throw r.error;state.cloudProfile=r.data;state.user.avatarUrl=r.data.avatar_url;refreshAccountIdentity();setAvatarElement($('#profile-avatar-preview'),r.data.avatar_url,state.user.name);showToast('Foto de perfil atualizada!');}catch(err){showToast(err.message||'Erro ao enviar foto.','error');}}
async function handlePublishMusic(e){e.preventDefault();const b=$('#publish-submit');if(b.disabled)return;const old=b.textContent;b.disabled=true;b.textContent='Publicando…';try{if(!state.cloudUser)throw new Error('Entre para publicar músicas.');const title=$('#publish-title').value.trim(),artist=$('#publish-artist').value.trim()||(state.cloudProfile&&state.cloudProfile.display_name)||state.user.name,description=$('#publish-description').value.trim(),file=$('#publish-audio').files&&$('#publish-audio').files[0],cover=$('#publish-cover').files&&$('#publish-cover').files[0];if(title.length<2||title.length>80)throw new Error('Título: 2 a 80 caracteres.');if(description.length>500)throw new Error('Descrição: até 500 caracteres.');if(!file)throw new Error('Escolha o arquivo de áudio.');const allowed=['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/ogg','audio/mp4','audio/aac','audio/flac','audio/webm'];if(!allowed.includes(file.type))throw new Error('Formato não aceito. Use MP3, WAV, OGG, M4A, AAC, FLAC ou WebM.');if(file.size>25*1024*1024)throw new Error('O áudio deve ter até 25 MB.');if(cover&&(!['image/jpeg','image/png','image/webp'].includes(cover.type)||cover.size>3*1024*1024))throw new Error('A capa deve ter até 3 MB.');const id=crypto.randomUUID(),ext=(file.name.split('.').pop()||'mp3').toLowerCase().replace(/[^a-z0-9]/g,'')||'mp3',a=await uploadSonoraMedia(file,state.cloudUser.id+'/tracks/'+id+'.'+ext);let c=null;try{if(cover){const ce=cover.type==='image/png'?'png':(cover.type==='image/webp'?'webp':'jpg');c=await uploadSonoraMedia(cover,state.cloudUser.id+'/covers/'+id+'.'+ce);}const r=await state.supabaseClient.from('tracks').insert({id,user_id:state.cloudUser.id,title,artist,description,audio_path:a.path,audio_url:a.url,cover_path:c?c.path:null,cover_url:c?c.url:null,status:'published'}).select('*').single();if(r.error)throw r.error;state.communityTracks.unshift(Object.assign({},r.data,{source:'community',audio:r.data.audio_url,publisher:state.cloudProfile.display_name,username:state.cloudProfile.username,publisherAvatar:state.cloudProfile.avatar_url||''}));renderCommunityFeed();$('#publish-music-form').reset();showToast('Música publicada!');}catch(err){await state.supabaseClient.storage.from('sonora-media').remove([a.path].concat(c?[c.path]:[]));throw err;}}catch(err){console.error(err);showToast(err.message||'Não consegui publicar.','error');}finally{b.disabled=false;b.textContent=old;}}
async function deleteCommunityTrack(id){const t=state.communityTracks.find(x=>x.id===id);if(!t||!state.cloudUser||t.user_id!==state.cloudUser.id){showToast('Você só pode remover suas músicas.','error');return;}const r=await state.supabaseClient.from('tracks').delete().eq('id',id);if(r.error){showToast(r.error.message,'error');return;}const paths=[t.audio_path,t.cover_path].filter(Boolean);if(paths.length)await state.supabaseClient.storage.from('sonora-media').remove(paths);state.communityTracks=state.communityTracks.filter(x=>x.id!==id);renderCommunityFeed();showToast('Publicação removida.');}
async function reportCommunityTrack(id){if(!state.cloudUser){showToast('Entre para denunciar.','error');return;}const reason=prompt('Por que esta publicação deve ser analisada?');if(!reason)return;const r=await state.supabaseClient.from('reports').insert({reporter_id:state.cloudUser.id,track_id:id,reason:reason.slice(0,500)});if(r.error)showToast(r.error.message,'error');else showToast('Denúncia enviada.');}
function openAuthScreen(mode){$('#app-shell').classList.add('hidden');$('#auth-screen').classList.remove('hidden');setAuthMode(mode||'signup');}

function choosePlaylist(track){if(!state.playlists.length){showToast('Crie uma playlist primeiro.','error');return;}openModal(`<h2>Adicionar à playlist</h2><p>Escolha onde guardar “${safeText(track.title)}”.</p>${state.playlists.map(p=>`<button class="playlist-choice" data-choose-playlist="${safeText(p.id)}">♫ &nbsp;${safeText(p.name)}</button>`).join('')}`);$$('[data-choose-playlist]').forEach(b=>b.addEventListener('click',()=>{const p=state.playlists.find(x=>x.id===b.dataset.choosePlaylist);const k=trackKey(track);if(p&&!p.tracks.includes(k))p.tracks.push(k);if(track.source!=='local'&&!state.savedOnline.some(x=>x.id===track.id))state.savedOnline.unshift({...track});saveVault();closeModal();renderPlaylists();showToast('Música adicionada à playlist.');}));}

const tutorial=[
  {label:'PRIMEIRO CONTATO',title:'Oi! Eu sou o Lumi.',text:'Vou te mostrar como o Sonora funciona, passo a passo. Não precisa entender de tecnologia: é só acompanhar. Preparado para descobrir seu novo player?',tip:'Você pode reabrir este tutorial quando quiser tocando no ícone ✧, lá no topo.'},
  {label:'SUA BIBLIOTECA',title:'Traga suas músicas.',text:'Você pode clicar em “Adicionar arquivos” ou simplesmente arrastar músicas do computador para a área indicada. O Sonora tenta reconhecer título e artista pelas informações do arquivo.',tip:'Os arquivos importados ficam neste navegador, protegidos no cofre local. Não são enviados para um servidor.'},
  {label:'DESCOBRIR',title:'Busque novos sons.',text:'Na aba Descobrir, você já encontra músicas em alta no catálogo Audius. Pesquise por música, artista ou estilo e aperte Play para ouvir direto no Sonora.',tip:'O Sonora transmite pelo Audius e mostra um link para a página original do artista. Isso não significa que a faixa seja livre para reutilização fora da plataforma.'},
  {label:'REELS',title:'Crie vídeos curtos no seu ritmo.',text:'A área Reels tem projetos inacabados para você desenvolver. Abra um rascunho, escreva uma ideia, escolha um vídeo e salve. Nada será publicado automaticamente.',tip:'Os 100 cartões são ideias de partida. Você pode alterar títulos, descrições e anexar seus próprios vídeos.'},
  {label:'ALGORITMO',title:'O Sonora aprende com você.',text:'Quando você ouve, favorita ou organiza uma faixa, o algoritmo registra seus gostos. Ele usa gêneros, artistas e frequência de reprodução para ordenar recomendações.',tip:'No começo as sugestões são gerais. Quanto mais você usa, mais personalizadas ficam.'},
  {label:'PRONTO!',title:'Agora é com você!',text:'Crie playlists, favorite suas descobertas e aproveite. O botão de reprodução fica sempre na parte inferior da tela.',tip:'Dica: use o botão de coração para ensinar ao algoritmo quais músicas você curte.'}
];
function startTutorial(){state.tutorialStep=0;renderTutorial();$('#tutorial-overlay').classList.remove('hidden');}
function renderTutorial(){const s=tutorial[state.tutorialStep];$('#tutorial-step-label').textContent=s.label;$('#tutorial-title').textContent=s.title;$('#tutorial-text').textContent=s.text;$('#tutorial-tip-text').textContent=s.tip;$('#tutorial-dots').innerHTML=tutorial.map((_,i)=>`<i class="${i<=state.tutorialStep?'active':''}"></i>`).join('');$('#tutorial-back').classList.toggle('hidden',state.tutorialStep===0);$('#tutorial-next').innerHTML=state.tutorialStep===tutorial.length-1?'Começar a explorar <span>✦</span>':'Próximo <span>→</span>';}
function nextTutorial(){if(state.tutorialStep<tutorial.length-1){state.tutorialStep++;renderTutorial();}else{finishTutorial();}}
function finishTutorial(){localStorage.setItem('sonora-tutorial-done','1');$('#tutorial-overlay').classList.add('hidden');showToast('Bem-vindo ao Sonora! ✦');}

function setAuthMode(mode){
 state.authMode=mode==='login'?'login':'signup';
 const signup=state.authMode==='signup';
 const username=$('#auth-username'),label=username.previousElementSibling;
 username.classList.toggle('hidden',!signup);label.classList.toggle('hidden',!signup);username.required=signup;
 $('#auth-password').autocomplete=signup?'new-password':'current-password';
 $('#auth-title').textContent=signup?'Crie sua conta.':'Entre no Sonora.';
 $('#auth-subtitle').textContent=signup?'Crie seu perfil online para publicar músicas e aparecer na comunidade.':'Entre para acessar seu perfil e suas publicações em qualquer dispositivo.';
 $('#auth-submit').textContent=signup?'Criar conta →':'Entrar →';
 $('#auth-mode-toggle').textContent=signup?'Já tem conta? Entrar':'Ainda não tem conta? Criar conta';
 $('#auth-error').textContent='';
}
function cloudReady(){const c=window.SONORA_CONFIG||{};return !!(state.supabaseClient&&c.supabaseUrl&&c.supabaseAnonKey);}
async function initAuth(forceGuest=false){
 setAuthMode('signup');const c=window.SONORA_CONFIG||{};
 if(!window.supabase||!window.supabase.createClient||!c.supabaseUrl||!c.supabaseAnonKey){$('#auth-error').textContent='Falta conectar o projeto online. Veja SUPABASE_SETUP.md no repositório Sonora.';return;}
 try{state.supabaseClient=window.supabase.createClient(c.supabaseUrl,c.supabaseAnonKey,{auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:true}});const r=await state.supabaseClient.auth.getSession();if(r.error)throw r.error;if(!forceGuest&&r.data.session&&r.data.session.user)await openCloudSession(r.data.session.user);}
 catch(e){console.error(e);$('#auth-error').textContent='Falha ao conectar: '+(e.message||'verifique o backend.');}
}
async function openCloudSession(user){
 const r=await state.supabaseClient.from('profiles').select('*').eq('id',user.id).maybeSingle();
 if(r.error)throw new Error('Não consegui carregar o perfil. Confira o SQL do Supabase: '+r.error.message);
 if(!r.data)throw new Error('O perfil não foi criado pelo banco. Confira o gatilho SQL.');
 state.cloudUser=user;state.cloudProfile=r.data;state.key=null;
 state.user={id:user.id,name:r.data.display_name,username:r.data.username,avatarUrl:r.data.avatar_url||'',bio:r.data.bio||'',email:user.email||'',cloud:true};
 $('#auth-screen').classList.add('hidden');$('#app-shell').classList.remove('hidden');
 renderAll();switchView('home');loadAudiusCatalog();loadCommunityTracks();
}
async function handleAuth(e){
 e.preventDefault();const b=$('#auth-submit');if(b.disabled)return;const old=b.textContent;b.disabled=true;b.textContent='Conectando…';$('#auth-error').textContent='';
 try{
  if(!cloudReady())throw new Error('As contas online precisam ser conectadas primeiro. Abra SUPABASE_SETUP.md e configure backend-config.js.');
  const email=$('#auth-email').value.trim().toLowerCase(),password=$('#auth-password').value;
  if(!email)throw new Error('Digite seu e-mail.');
  if(password.length<8)throw new Error('A senha precisa ter pelo menos 8 caracteres.');
  if(state.authMode==='signup'){
   const username=$('#auth-username').value.trim().toLowerCase();
   if(!/^[a-z0-9_]{3,24}$/.test(username))throw new Error('O nome de usuário deve ter de 3 a 24 caracteres: letras sem acento, números ou _.');
   const r=await state.supabaseClient.auth.signUp({email,password,options:{data:{username,display_name:$('#auth-username').value.trim()}}});
   if(r.error)throw r.error;
   if(r.data.session&&r.data.user){await openCloudSession(r.data.user);showToast('Conta criada! Bem-vindo à comunidade Sonora.');}
   else $('#auth-error').textContent='Cadastro recebido! Confirme o e-mail enviado e depois entre no Sonora.';
  }else{
   const r=await state.supabaseClient.auth.signInWithPassword({email,password});
   if(r.error)throw r.error;await openCloudSession(r.data.user);showToast('Login realizado. Bom ouvir!');
  }
 }catch(e){
  console.error(e);let m=e.message||'Não foi possível concluir.';
  if(/already registered|user already exists/i.test(m))m='Este e-mail já tem conta. Escolha Entrar.';
  if(/invalid login credentials/i.test(m))m='E-mail ou senha incorretos.';
  if(/duplicate|unique/i.test(m))m='Esse nome de usuário já está em uso. Escolha outro.';
  $('#auth-error').textContent=m;
 }finally{b.disabled=false;b.textContent=old;}
}
async function logout(){
 try{if(state.supabaseClient)await state.supabaseClient.auth.signOut();}catch(e){console.warn(e);}
 if(audio&&!audio.paused)audio.pause();
 state.cloudUser=null;state.cloudProfile=null;state.user=null;state.key=null;
 state.localTracks=[];state.onlineTracks=[];state.savedOnline=[];state.communityTracks=[];
 state.history=[];state.favorites=[];state.playlists=[];state.reelsDrafts=[];state.reelsInitialized=false;
 $('#app-shell').classList.add('hidden');$('#auth-screen').classList.remove('hidden');
 $('#auth-email').value='';$('#auth-password').value='';setAuthMode('login');
}
function enterGuestMode(){
  try{
    state.key=null;
    state.user={name:'Visitante'};
    state.localTracks=[];
    state.onlineTracks=[];
    state.savedOnline=[];
    state.playlists=[];
    state.favorites=[];
    state.history=[];
    state.current=null;
    state.queue=[];
    state.queueIndex=-1;
    state.reelsDrafts=[];
    state.reelsInitialized=false;
    $('#auth-error').textContent='';
    $('#sidebar-username').textContent='Visitante';
    $('#top-username').textContent='Visitante';
    $('#user-avatar').textContent='V';
    $('#top-avatar').textContent='V';
    $('#auth-screen').classList.add('hidden');
    state.cloudUser=null;state.cloudProfile=null;
    $('#app-shell').classList.remove('hidden');
    switchView('discover');
    loadCommunityTracks();
    showToast('Você entrou como visitante. Para publicar músicas, crie uma conta.');
  }catch(err){
    console.error('Não foi possível abrir o modo visitante:',err);
    $('#app-shell').classList.add('hidden');
    $('#auth-screen').classList.remove('hidden');
    $('#auth-error').textContent='Não consegui abrir o player: '+(err?.message||'erro inesperado');
  }
}

function addDropHandlers(zone){if(!zone)return;zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over');});zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag-over');importFiles(e.dataTransfer.files);});}
function wireEvents(){
  $('#auth-form').addEventListener('submit',handleAuth);
  $('#auth-mode-toggle').addEventListener('click',()=>setAuthMode(state.authMode==='signup'?'login':'signup'));
  $('#auth-guest').addEventListener('click',event=>{event.preventDefault();enterGuestMode();});
  $$('[data-view]').forEach(el=>el.addEventListener('click',()=>switchView(el.dataset.view)));
  $('#hero-discover').addEventListener('click',()=>switchView('discover'));
  $('#hero-import').addEventListener('click',()=>$('#file-picker').click());
  $('#drop-browse').addEventListener('click',()=>$('#file-picker').click());$('#library-import').addEventListener('click',()=>$('#file-picker').click());$('#library-browse').addEventListener('click',()=>$('#file-picker').click());$('#file-picker').addEventListener('change',e=>{importFiles(e.target.files);e.target.value='';});
  addDropHandlers($('#home-drop-zone'));addDropHandlers($('#library-drop-zone'));addDropHandlers(document.body);
  $('#online-search-btn').addEventListener('click',()=>runOnlineSearch($('#online-search').value));$('#online-search').addEventListener('keydown',e=>{if(e.key==='Enter')runOnlineSearch($('#online-search').value);});
  $('#catalog-refresh').addEventListener('click',()=>loadAudiusCatalog());
  $('#catalog-genres').addEventListener('click',e=>{const button=e.target.closest('[data-audius-genre]');if(!button)return;$$('[data-audius-genre]').forEach(x=>x.classList.toggle('active',x===button));$('#online-search').value='';loadAudiusCatalog({genre:button.dataset.audiusGenre});});
  $$('.filter-chip').forEach(b=>b.addEventListener('click',()=>{$$('.filter-chip').forEach(x=>x.classList.toggle('active',x===b));state.libraryFilter=b.dataset.libraryFilter;renderLibrary();}));
  $('#play-btn').addEventListener('click',()=>{if(!state.current){switchView('discover');return;}if(audio.paused)audio.play().catch(()=>{});else audio.pause();});$('#prev-btn').addEventListener('click',()=>playNext(-1));$('#next-btn').addEventListener('click',()=>playNext(1));$('#shuffle-btn').addEventListener('click',()=>{state.shuffle=!state.shuffle;$('#shuffle-btn').classList.toggle('active',state.shuffle);});$('#repeat-btn').addEventListener('click',()=>{state.repeat=!state.repeat;$('#repeat-btn').classList.toggle('active',state.repeat);});$('#seek-bar').addEventListener('input',()=>{if(audio.duration)audio.currentTime=(Number($('#seek-bar').value)/1000)*audio.duration;});$('#volume-bar').addEventListener('input',()=>audio.volume=Number($('#volume-bar').value));$('#player-like').addEventListener('click',()=>{if(state.current)toggleFavorite(state.current);});$('#queue-btn').addEventListener('click',()=>showToast(`Fila atual: ${state.queue.length} faixa(s).`));
  $('#new-playlist-side').addEventListener('click',createPlaylist);$('#new-playlist-main').addEventListener('click',createPlaylist);$('#back-playlists').addEventListener('click',closePlaylist);
  $('#tutorial-restart').addEventListener('click',startTutorial);$('#tutorial-next').addEventListener('click',nextTutorial);$('#tutorial-back').addEventListener('click',()=>{state.tutorialStep=Math.max(0,state.tutorialStep-1);renderTutorial();});$('#tutorial-skip').addEventListener('click',finishTutorial);
  $('#modal-close').addEventListener('click',closeModal);$('#modal-overlay').addEventListener('click',e=>{if(e.target===$('#modal-overlay'))closeModal();});
  $('#logout-btn').addEventListener('click',logout);
  $('#profile-button').addEventListener('click',()=>state.cloudUser?switchView('profile'):openAuthScreen('login'));
  $('#profile-form').addEventListener('submit',e=>handleProfileSave(e).catch(err=>showToast(err.message,'error')));
  $('#avatar-picker').addEventListener('change',handleAvatarChange);
  $('#choose-avatar').addEventListener('click',()=>$('#avatar-picker').click());
  $('#publish-music-form').addEventListener('submit',handlePublishMusic);
  $('#community-refresh').addEventListener('click',loadCommunityTracks);
  $('#community-signin').addEventListener('click',()=>openAuthScreen('signup'));
  $('#profile-login').addEventListener('click',()=>openAuthScreen('signup'));
  $('#community-feed').addEventListener('click',e=>{const d=e.target.closest('[data-delete-track]');const r=e.target.closest('[data-report-track]');if(d)deleteCommunityTrack(d.dataset.deleteTrack);if(r)reportCommunityTrack(r.dataset.reportTrack);});
  $('#reel-create-main').addEventListener('click',createReelDraft);
  $('#reels-search').addEventListener('input',e=>{state.reelSearch=e.target.value;state.reelsVisible=20;renderReels();});
  $$('.reel-filter').forEach(b=>b.addEventListener('click',()=>{$$('.reel-filter').forEach(x=>x.classList.toggle('active',x===b));state.reelFilter=b.dataset.reelFilter;state.reelsVisible=20;renderReels();}));
  $('#reels-load-more').addEventListener('click',()=>{state.reelsVisible+=20;renderReels();});
  $('#reels-grid').addEventListener('click',e=>{const edit=e.target.closest('[data-reel-edit]');const preview=e.target.closest('[data-reel-preview]');if(edit)openReelEditor(edit.dataset.reelEdit);if(preview)openReelPreview(preview.dataset.reelPreview);});
  $('#reset-algorithm').addEventListener('click',async()=>{state.history=[];state.favorites=[];await saveVault();renderAll();showToast('Aprendizado reiniciado.');});
  $('#delete-account-data').addEventListener('click',()=>{openModal('<h2>Apagar todos os dados?</h2><p>Isso remove a conta local, músicas importadas, playlists e histórico deste navegador. Esta ação não pode ser desfeita.</p><div class="modal-actions"><button class="outline-btn" id="cancel-delete">Cancelar</button><button class="primary-btn" id="confirm-delete">Apagar tudo</button></div>');$('#cancel-delete').addEventListener('click',closeModal);$('#confirm-delete').addEventListener('click',async()=>{closeModal();audio.pause();await dbClear('vault');await dbClear('meta');await dbClear('media');state.key=null;state.localTracks=[];state.playlists=[];state.favorites=[];state.history=[];state.reelsDrafts=[];state.reelsInitialized=false;$('#app-shell').classList.add('hidden');$('#auth-screen').classList.remove('hidden');$('#auth-username').classList.remove('hidden');$('#auth-username').previousElementSibling.classList.remove('hidden');$('#auth-username').value='';$('#auth-password').value='';state.savedOnline=[];await initAuth();showToast('Dados apagados deste navegador.');});});
}

(async function boot(){try{wireEvents();const guestMode=new URLSearchParams(location.search).get('guest')==='1';if(guestMode){enterGuestMode();history.replaceState({},'',location.pathname+location.hash);await initAuth(true);loadCommunityTracks();}else{await initAuth(false);}}catch(e){console.error('Falha ao iniciar Sonora:',e);document.body.innerHTML='<div style="padding:32px;color:white;font-family:sans-serif"><h2>Não foi possível iniciar o Sonora</h2><p>'+safeText(e.message)+'</p><p>Tente recarregar a página.</p></div>';}})();